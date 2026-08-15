use std::io::{self, Read, Write};
use zeroize::Zeroize;

pub const MAX_PAYLOAD_BYTES: usize = 512;
pub const MAX_BUFFERED_RECORD_BYTES: usize = 516;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Length,
    Truncated,
    Utf8,
    Bom,
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<String, FrameError> {
    let mut header = [0_u8; 4];
    read_exact_classified(reader, &mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if !(1..=MAX_PAYLOAD_BYTES).contains(&length) {
        return Err(FrameError::Length);
    }
    let mut payload = vec![0_u8; length];
    if let Err(error) = read_exact_classified(reader, &mut payload) {
        payload.zeroize();
        return Err(error);
    }
    if payload.starts_with(&[0xef, 0xbb, 0xbf]) {
        payload.zeroize();
        return Err(FrameError::Bom);
    }
    match String::from_utf8(payload) {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut rejected = error.into_bytes();
            rejected.zeroize();
            Err(FrameError::Utf8)
        }
    }
}

pub fn write_frame<W: Write>(writer: &mut W, payload: &str) -> io::Result<()> {
    let bytes = payload.as_bytes();
    if !(1..=MAX_PAYLOAD_BYTES).contains(&bytes.len()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame length"));
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}

fn read_exact_classified<R: Read>(reader: &mut R, output: &mut [u8]) -> Result<(), FrameError> {
    let mut offset = 0;
    while offset < output.len() {
        match reader.read(&mut output[offset..]) {
            Ok(0) => return Err(FrameError::Truncated),
            Ok(read) => offset += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(FrameError::Truncated),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip_and_exact_bounds() {
        let mut framed = Vec::new();
        write_frame(&mut framed, "{}").unwrap();
        assert_eq!(read_frame(&mut Cursor::new(framed)).unwrap(), "{}");
        assert_eq!(
            read_frame(&mut Cursor::new([0, 0, 0, 0])),
            Err(FrameError::Length)
        );
        assert_eq!(
            read_frame(&mut Cursor::new([0, 0, 2, 1])),
            Err(FrameError::Length)
        );
    }

    #[test]
    fn fragmented_and_truncated_input_is_bounded() {
        struct OneByte(Cursor<Vec<u8>>);
        impl Read for OneByte {
            fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
                let length = output.len().min(1);
                self.0.read(&mut output[..length])
            }
        }
        let mut bytes = vec![0, 0, 0, 2, b'{', b'}'];
        assert_eq!(
            read_frame(&mut OneByte(Cursor::new(bytes.clone()))).unwrap(),
            "{}"
        );
        bytes.pop();
        assert_eq!(
            read_frame(&mut Cursor::new(bytes)),
            Err(FrameError::Truncated)
        );
    }

    #[test]
    fn rejects_utf8_and_bom() {
        assert_eq!(
            read_frame(&mut Cursor::new([0, 0, 0, 1, 0xff])),
            Err(FrameError::Utf8)
        );
        assert_eq!(
            read_frame(&mut Cursor::new([0, 0, 0, 5, 0xef, 0xbb, 0xbf, b'{', b'}'])),
            Err(FrameError::Bom),
        );
    }

    #[test]
    fn maximum_payload_and_large_coalesced_input_never_change_the_record_bound() {
        let payload = "x".repeat(MAX_PAYLOAD_BYTES);
        let mut one = Vec::new();
        write_frame(&mut one, &payload).unwrap();
        assert_eq!(one.len(), MAX_BUFFERED_RECORD_BYTES);
        let coalesced = one.repeat(4_096);
        let mut cursor = Cursor::new(coalesced);
        for _ in 0..4_096 {
            assert_eq!(read_frame(&mut cursor).unwrap(), payload);
        }
        assert_eq!(cursor.position() as usize, one.len() * 4_096);
    }
}
