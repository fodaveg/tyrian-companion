use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use tyrian_mumble_helper::framing::{read_frame, write_frame};

const TOKEN_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B: &str = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Helper {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tyrian-mumble-helper"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            stdin: child.stdin.take(),
            stdout: child.stdout.take().unwrap(),
            child,
        }
    }

    fn bootstrap(&mut self, token: &str) -> u16 {
        write_frame(
            self.stdin.as_mut().unwrap(),
            &format!(r#"{{"kind":"bootstrap","version":1,"token":"{token}"}}"#),
        )
        .unwrap();
        let ready = read_frame(&mut self.stdout).unwrap_or_else(|error| {
            panic!("ready failed: {error:?}; child={:?}", self.child.try_wait())
        });
        assert!(ready.starts_with(r#"{"kind":"ready","version":1,"host":"127.0.0.1","port":"#));
        ready
            .trim_end_matches('}')
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }

    fn close_stdin(&mut self) {
        drop(self.stdin.take());
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.close_stdin();
        let _ = self.child.wait();
    }
}

fn connect(port: u16, token: &str) -> (TcpStream, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write_frame(
        &mut stream,
        &format!(r#"{{"kind":"hello","version":1,"token":"{token}"}}"#),
    )
    .unwrap();
    let welcome = read_frame(&mut stream).unwrap();
    let marker = r#""nonce":""#;
    let start = welcome.find(marker).unwrap() + marker.len();
    let nonce = welcome[start..].split('"').next().unwrap().to_owned();
    assert_eq!(nonce.len(), 22);
    (stream, nonce)
}

#[test]
fn auth_reconnect_fresh_nonce_sequence_and_eof_shutdown() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_A);

    let mut rejected = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write_frame(
        &mut rejected,
        &format!(r#"{{"kind":"hello","version":1,"token":"{TOKEN_B}"}}"#),
    )
    .unwrap();
    rejected
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    assert!(read_frame(&mut rejected).is_err());

    let (mut first, first_nonce) = connect(port, TOKEN_A);
    let cadence_started = Instant::now();
    let first_record = read_frame(&mut first).unwrap();
    assert!(first_record.contains(&format!(r#""nonce":"{first_nonce}""#)));
    assert!(first_record.contains(r#""sequence":0"#));
    assert!(first_record.contains(r#""sourceStatus":"mapping_unavailable""#));
    let next_record = read_frame(&mut first).unwrap();
    assert!(next_record.contains(r#""sequence":1"#));
    assert!(cadence_started.elapsed() >= Duration::from_millis(400));
    first.shutdown(Shutdown::Both).unwrap();
    std::thread::sleep(Duration::from_millis(1_200));

    let (mut second, second_nonce) = connect(port, TOKEN_A);
    assert_ne!(first_nonce, second_nonce);
    let second_record = read_frame(&mut second).unwrap();
    assert!(second_record.contains(r#""sequence":0"#));

    helper.close_stdin();
    let mut byte = [0_u8; 1];
    assert_eq!(second.read(&mut byte).unwrap_or(0), 0);
}

#[test]
fn slowloris_does_not_admit_an_additional_client() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_A);
    let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
    slow.write_all(&[0, 0]).unwrap();
    let mut extra = TcpStream::connect(("127.0.0.1", port)).unwrap();
    extra
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut byte = [0_u8; 1];
    assert_eq!(extra.read(&mut byte).unwrap_or(0), 0);
    helper.close_stdin();
}

#[test]
fn one_authenticated_and_one_pending_are_kept_while_a_third_is_rejected() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_A);
    let (active, active_nonce) = connect(port, TOKEN_A);

    let mut pending = TcpStream::connect(("127.0.0.1", port)).unwrap();
    pending
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write_frame(
        &mut pending,
        &format!(r#"{{"kind":"hello","version":1,"token":"{TOKEN_A}"}}"#),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));

    let mut third = TcpStream::connect(("127.0.0.1", port)).unwrap();
    third
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut byte = [0_u8; 1];
    assert_eq!(third.read(&mut byte).unwrap_or(0), 0);

    active.shutdown(Shutdown::Both).unwrap();
    let welcome = read_frame(&mut pending).unwrap();
    assert!(!welcome.contains(&active_nonce));
    let first_record = read_frame(&mut pending).unwrap();
    assert!(first_record.contains(r#""sequence":0"#));
    helper.close_stdin();
}

#[test]
fn slowloris_is_closed_at_the_two_second_hello_deadline() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_A);
    let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
    slow.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    slow.write_all(&[0, 0]).unwrap();
    let started = Instant::now();
    let mut byte = [0_u8; 1];
    assert_eq!(slow.read(&mut byte).unwrap_or(0), 0);
    assert!(started.elapsed() >= Duration::from_millis(1_900));
    helper.close_stdin();
}

#[test]
fn truncated_bom_and_invalid_utf8_hello_payloads_fail_closed() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_A);

    for (bytes, truncate) in [
        (vec![0, 0, 0, 4, b'{', b'}'], true),
        (vec![0, 0, 0, 3, 0xef, 0xbb, 0xbf], false),
        (vec![0, 0, 0, 1, 0xff], false),
    ] {
        let mut rejected = TcpStream::connect(("127.0.0.1", port)).unwrap();
        rejected
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        rejected.write_all(&bytes).unwrap();
        if truncate {
            rejected.shutdown(Shutdown::Write).unwrap();
        }
        let mut byte = [0_u8; 1];
        assert_eq!(rejected.read(&mut byte).unwrap_or(0), 0);
    }
    helper.close_stdin();
}

#[test]
fn eof_after_ready_closes_the_listener_without_a_client() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_A);
    helper.close_stdin();
    assert!(helper.child.wait().unwrap().success());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}

#[test]
fn a_new_process_binds_hello_to_its_own_bootstrap_token() {
    let mut helper = Helper::start();
    let port = helper.bootstrap(TOKEN_B);
    let mut stale = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stale
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write_frame(
        &mut stale,
        &format!(r#"{{"kind":"hello","version":1,"token":"{TOKEN_A}"}}"#),
    )
    .unwrap();
    assert!(read_frame(&mut stale).is_err());
    let (_accepted, _nonce) = connect(port, TOKEN_B);
    helper.close_stdin();
}

#[test]
fn eof_before_bootstrap_is_a_clean_terminal_shutdown() {
    let mut helper = Helper::start();
    helper.close_stdin();
    assert!(helper.child.wait().unwrap().success());
}
