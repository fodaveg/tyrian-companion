use std::io::{self, Read};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use tyrian_mumble_helper::framing::{read_frame, write_frame, MAX_PAYLOAD_BYTES};
use tyrian_mumble_helper::protocol::{
    fresh_nonce, heartbeat, parse_bootstrap, parse_hello, ready, sample, welcome, ProcessToken,
    Sequence, SourceStatus, HELLO_TIMEOUT_MS,
};
use tyrian_mumble_helper::source::{
    CadenceDecision, CadenceSchedule, Projection, ProjectionClock, Sample,
};
use zeroize::Zeroize;

fn main() {
    if run().is_err() {
        std::process::exit(1);
    }
}

fn run() -> Result<(), ()> {
    let shutdown = Arc::new(AtomicBool::new(false));
    let (bootstrap_sender, bootstrap_receiver) = mpsc::sync_channel(1);
    let stdin_shutdown = Arc::clone(&shutdown);
    thread::spawn(move || stdin_task(bootstrap_sender, stdin_shutdown));

    let mut bootstrap_frame = match bootstrap_receiver.recv() {
        Ok(frame) => frame,
        Err(_) if shutdown.load(Ordering::Acquire) => return Ok(()),
        Err(_) => return Err(()),
    };
    let parsed_bootstrap = parse_bootstrap(&bootstrap_frame);
    bootstrap_frame.zeroize();
    let mut bootstrap = parsed_bootstrap.map_err(|_| ())?;
    let token = ProcessToken::parse(&bootstrap.token).map_err(|_| ())?;
    bootstrap.token.zeroize();
    if shutdown.load(Ordering::Acquire) {
        return Ok(());
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| ())?;
    listener.set_nonblocking(true).map_err(|_| ())?;
    let port = listener.local_addr().map_err(|_| ())?.port();
    write_frame(&mut io::stdout().lock(), &ready(port)).map_err(|_| ())?;

    let mut pending = None;
    while !shutdown.load(Ordering::Acquire) {
        let candidate = match pending.take() {
            Some(connection) => Ok(Some(connection)),
            None => accept_pending(&listener),
        };
        match candidate {
            Ok(Some(connection)) => {
                pending = serve_connection(&listener, connection, &token, &shutdown);
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(()) => return Err(()),
        }
    }
    drop(token);
    Ok(())
}

struct PendingConnection {
    stream: TcpStream,
    accepted_at: Instant,
}

fn accept_pending(listener: &TcpListener) -> Result<Option<PendingConnection>, ()> {
    match listener.accept() {
        Ok((stream, address)) if address.ip() == Ipv4Addr::LOCALHOST => {
            Ok(Some(PendingConnection {
                stream,
                accepted_at: Instant::now(),
            }))
        }
        Ok((stream, _)) => {
            let _ = stream.shutdown(Shutdown::Both);
            Ok(None)
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(_) => Err(()),
    }
}

fn maintain_pending_connection(listener: &TcpListener, pending: &mut Option<PendingConnection>) {
    if pending.as_ref().is_some_and(|connection| {
        connection.accepted_at.elapsed() >= Duration::from_millis(HELLO_TIMEOUT_MS)
    }) {
        if let Some(connection) = pending.take() {
            let _ = connection.stream.shutdown(Shutdown::Both);
        }
    }
    loop {
        match listener.accept() {
            Ok((stream, address)) if address.ip() == Ipv4Addr::LOCALHOST && pending.is_none() => {
                *pending = Some(PendingConnection {
                    stream,
                    accepted_at: Instant::now(),
                });
            }
            Ok((stream, _)) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return,
            Err(_) => return,
        }
    }
}

fn stdin_task(sender: mpsc::SyncSender<String>, shutdown: Arc<AtomicBool>) {
    let mut input = io::stdin().lock();
    if let Ok(frame) = read_frame(&mut input) {
        let _ = sender.send(frame);
    } else {
        drop(sender);
        shutdown.store(true, Ordering::Release);
        return;
    }
    let mut byte = [0_u8; 1];
    let _ = input.read(&mut byte);
    shutdown.store(true, Ordering::Release);
}

fn serve_connection(
    listener: &TcpListener,
    mut connection: PendingConnection,
    token: &ProcessToken,
    shutdown: &AtomicBool,
) -> Option<PendingConnection> {
    let accepted_at = connection.accepted_at;
    let stream = &mut connection.stream;
    if stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .is_err()
    {
        return None;
    }
    let deadline = accepted_at + Duration::from_millis(HELLO_TIMEOUT_MS);
    let mut hello_frame = read_tcp_frame(listener, stream, deadline, shutdown).ok()?;
    let parsed_hello = parse_hello(&hello_frame);
    hello_frame.zeroize();
    let mut hello = parsed_hello.ok()?;
    if !token.matches_encoded(&hello.token) {
        hello.token.zeroize();
        return None;
    }
    hello.token.zeroize();

    let nonce = fresh_nonce().ok()?;
    write_frame(stream, &welcome(&nonce)).ok()?;
    stream.set_nonblocking(true).ok()?;
    let mut sequence = Sequence::default();
    let mut projection = ProjectionClock::default();
    let cadence_started = Instant::now();
    let mut cadence = CadenceSchedule::new(Duration::ZERO);
    let mut pending = None;
    loop {
        if shutdown.load(Ordering::Acquire) {
            return pending;
        }
        let mut unexpected = [0_u8; 1];
        match stream.peek(&mut unexpected) {
            Ok(0) => return pending,
            Ok(_) => return pending,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => return pending,
        }
        maintain_pending_connection(listener, &mut pending);
        let now = cadence_started.elapsed();
        match cadence.poll(now) {
            CadenceDecision::NotDue => {
                let remaining = cadence.next_slot_at().saturating_sub(now);
                thread::sleep(remaining.min(Duration::from_millis(10)));
                continue;
            }
            CadenceDecision::HeartbeatTimeout => return pending,
            CadenceDecision::Due => {}
        }
        match projection.project(source_sample(), now) {
            Projection::Sample {
                sample: observation,
                activity,
            } => {
                let record = sample(
                    &nonce,
                    sequence.take().ok()?,
                    observation.tick,
                    observation.map_id,
                    activity,
                );
                if write_frame(stream, &record).is_err() {
                    return pending;
                }
            }
            Projection::Heartbeat(status) => {
                let record = heartbeat(&nonce, sequence.take().ok()?, status);
                if write_frame(stream, &record).is_err() {
                    return pending;
                }
            }
        }
        cadence.record_emitted(cadence_started.elapsed());
    }
}

fn read_tcp_frame(
    listener: &TcpListener,
    stream: &mut TcpStream,
    deadline: Instant,
    shutdown: &AtomicBool,
) -> Result<String, ()> {
    let mut header = [0_u8; 4];
    read_until(listener, stream, &mut header, deadline, shutdown)?;
    let length = u32::from_be_bytes(header) as usize;
    if !(1..=MAX_PAYLOAD_BYTES).contains(&length) {
        return Err(());
    }
    let mut payload = vec![0_u8; length];
    if read_until(listener, stream, &mut payload, deadline, shutdown).is_err() {
        payload.zeroize();
        return Err(());
    }
    if payload.starts_with(&[0xef, 0xbb, 0xbf]) {
        payload.zeroize();
        return Err(());
    }
    match String::from_utf8(payload) {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut rejected = error.into_bytes();
            rejected.zeroize();
            Err(())
        }
    }
}

fn read_until(
    listener: &TcpListener,
    stream: &mut TcpStream,
    output: &mut [u8],
    deadline: Instant,
    shutdown: &AtomicBool,
) -> Result<(), ()> {
    let mut offset = 0;
    while offset < output.len() {
        reject_additional_connections(listener);
        if shutdown.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(());
        }
        match stream.read(&mut output[offset..]) {
            Ok(0) => return Err(()),
            Ok(read) => offset += read,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(()),
        }
    }
    Ok(())
}

fn reject_additional_connections(listener: &TcpListener) {
    loop {
        match listener.accept() {
            Ok((extra, _)) => {
                let _ = extra.shutdown(Shutdown::Both);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return,
            Err(_) => return,
        }
    }
}

#[cfg(windows)]
fn source_sample() -> Result<Sample, SourceStatus> {
    let mapping = tyrian_mumble_helper::win32::Mapping::open()?;
    mapping.sample()
}

#[cfg(not(windows))]
fn source_sample() -> Result<Sample, SourceStatus> {
    Err(SourceStatus::MappingUnavailable)
}
