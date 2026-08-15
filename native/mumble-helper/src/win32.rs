use crate::protocol::SourceStatus;
use crate::source::{read_stable, Sample, WordSource, VIEW_BYTES};
use std::ffi::c_void;
use std::ptr::NonNull;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS,
};

const MAPPING_NAME: &[u16] = &[77, 117, 109, 98, 108, 101, 76, 105, 110, 107, 0];

pub struct Mapping {
    handle: HANDLE,
    view: NonNull<u8>,
}

impl Mapping {
    pub fn open() -> Result<Self, SourceStatus> {
        // SAFETY: the fixed UTF-16 name is NUL-terminated; requested access is read-only.
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, MAPPING_NAME.as_ptr()) };
        if handle.is_null() {
            return Err(SourceStatus::MappingUnavailable);
        }
        // SAFETY: handle is live and the requested view is the pinned MumbleLink byte length.
        let raw = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, VIEW_BYTES) };
        let view = match NonNull::new(raw.Value.cast::<u8>()) {
            Some(view) => view,
            None => {
                // SAFETY: handle was returned by OpenFileMappingW and is closed exactly once.
                unsafe { CloseHandle(handle) };
                return Err(SourceStatus::MappingUnavailable);
            }
        };
        Ok(Self { handle, view })
    }

    pub fn sample(&self) -> Result<Sample, SourceStatus> {
        read_stable(self)
    }
}

impl WordSource for Mapping {
    fn read_word(&self, offset: usize) -> u32 {
        debug_assert!(offset + size_of::<u32>() <= VIEW_BYTES);
        // SAFETY: MapViewOfFile provides VIEW_BYTES readable bytes; every contractual offset is
        // aligned and in bounds. Volatile prevents combining the shared-memory word loads.
        unsafe { self.view.as_ptr().add(offset).cast::<u32>().read_volatile() }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: both resources are owned by self and released exactly once here.
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.view.as_ptr().cast::<c_void>(),
            });
            CloseHandle(self.handle);
        }
    }
}
