#![deny(unsafe_code)]

pub mod framing;
pub mod protocol;
pub mod source;

#[cfg(windows)]
#[allow(unsafe_code)]
pub mod win32;
