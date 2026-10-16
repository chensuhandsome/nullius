"""Windows handle-based file replacement and account-private runtime authority.

The project contracts writer needs the equivalent of a pinned POSIX dir_fd,
not a path check followed by an ordinary open. NtCreateFile and
NtSetInformationFile address children through an already open directory;
reparse points are refused and the parent handle does not share DELETE access.
No optional Python package or shell command participates in these checks.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from contextlib import contextmanager, ExitStack
import msvcrt
import os
import errno
from pathlib import Path
import secrets
import time

if os.name != "nt":
    raise ImportError("nullius_windows.filesystem is a Windows-only implementation")

_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_security = ctypes.WinDLL("advapi32", use_last_error=True)
_native = ctypes.WinDLL("ntdll")
_shell = ctypes.WinDLL("shell32", use_last_error=True)
_ole = ctypes.WinDLL("ole32")

_READ_CONTROL = 0x00020000
_WRITE_DAC = 0x00040000
_WRITE_OWNER = 0x00080000
_DELETE = 0x00010000
_SYNCHRONIZE = 0x00100000
_READ_DATA = 0x0001
_WRITE_DATA = 0x0002
_READ_ATTRIBUTES = 0x0080
_WRITE_ATTRIBUTES = 0x0100
_SHARE_ALL = 0x0007
_OPEN = 1
_CREATE = 2
_OPEN_IF = 3
_DIRECTORY = 0x00000001
_SYNCHRONOUS = 0x00000020
_NON_DIRECTORY = 0x00000040
_OPEN_REPARSE_POINT = 0x00200000
_ATTRIBUTE_DIRECTORY = 0x0010
_ATTRIBUTE_REPARSE_POINT = 0x0400
_ATTRIBUTE_READONLY = 0x0001
_OWNER = 0x0001
_GROUP = 0x0002
_DACL = 0x0004
_DACL_PROTECTED = 0x1000
_INVALID_HANDLE = ctypes.c_void_p(-1).value


class _UnicodeString(ctypes.Structure):
    _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT),
                ("Buffer", wintypes.LPWSTR)]


class _ObjectAttributes(ctypes.Structure):
    _fields_ = [("Length", wintypes.ULONG), ("RootDirectory", wintypes.HANDLE),
                ("ObjectName", ctypes.POINTER(_UnicodeString)),
                ("Attributes", wintypes.ULONG), ("SecurityDescriptor", wintypes.LPVOID),
                ("SecurityQualityOfService", wintypes.LPVOID)]


class _IoStatus(ctypes.Structure):
    _fields_ = [("Status", ctypes.c_void_p), ("Information", ctypes.c_size_t)]


class _FileInformation(ctypes.Structure):
    _fields_ = [("FileAttributes", wintypes.DWORD),
                ("CreationTime", wintypes.FILETIME), ("LastAccessTime", wintypes.FILETIME),
                ("LastWriteTime", wintypes.FILETIME), ("VolumeSerialNumber", wintypes.DWORD),
                ("FileSizeHigh", wintypes.DWORD), ("FileSizeLow", wintypes.DWORD),
                ("NumberOfLinks", wintypes.DWORD), ("FileIndexHigh", wintypes.DWORD),
                ("FileIndexLow", wintypes.DWORD)]


class _Acl(ctypes.Structure):
    _fields_ = [("AclRevision", wintypes.BYTE), ("Sbz1", wintypes.BYTE),
                ("AclSize", wintypes.WORD), ("AceCount", wintypes.WORD),
                ("Sbz2", wintypes.WORD)]


class _AceHeader(ctypes.Structure):
    _fields_ = [("AceType", wintypes.BYTE), ("AceFlags", wintypes.BYTE),
                ("AceSize", wintypes.WORD)]


class _Guid(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD), ("Data4", wintypes.BYTE * 8)]


def _signature(dll, name, arguments, result):
    function = getattr(dll, name)
    function.argtypes, function.restype = arguments, result
    return function


_create_file = _signature(_kernel, "CreateFileW", [wintypes.LPCWSTR, wintypes.DWORD,
    wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE], wintypes.HANDLE)
_close = _signature(_kernel, "CloseHandle", [wintypes.HANDLE], wintypes.BOOL)
_info = _signature(_kernel, "GetFileInformationByHandle", [wintypes.HANDLE,
    ctypes.POINTER(_FileInformation)], wintypes.BOOL)
_set_info = _signature(_kernel, "SetFileInformationByHandle", [wintypes.HANDLE,
    ctypes.c_int, wintypes.LPVOID, wintypes.DWORD], wintypes.BOOL)
_flush = _signature(_kernel, "FlushFileBuffers", [wintypes.HANDLE], wintypes.BOOL)
_read = _signature(_kernel, "ReadFile", [wintypes.HANDLE, wintypes.LPVOID,
    wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID], wintypes.BOOL)
_write = _signature(_kernel, "WriteFile", [wintypes.HANDLE, wintypes.LPCVOID,
    wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID], wintypes.BOOL)
_duplicate = _signature(_kernel, "DuplicateHandle", [wintypes.HANDLE, wintypes.HANDLE,
    wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
    wintypes.BOOL, wintypes.DWORD], wintypes.BOOL)
_current_process = _signature(_kernel, "GetCurrentProcess", [], wintypes.HANDLE)
_local_free = _signature(_kernel, "LocalFree", [wintypes.HLOCAL], wintypes.HLOCAL)
_nt_create = _signature(_native, "NtCreateFile", [ctypes.POINTER(wintypes.HANDLE),
    wintypes.DWORD, ctypes.POINTER(_ObjectAttributes), ctypes.POINTER(_IoStatus),
    wintypes.LPVOID, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG,
    wintypes.LPVOID, wintypes.ULONG], wintypes.LONG)
_nt_error = _signature(_native, "RtlNtStatusToDosError", [wintypes.LONG], wintypes.ULONG)
_nt_set_info = _signature(_native, "NtSetInformationFile", [wintypes.HANDLE,
    ctypes.POINTER(_IoStatus), wintypes.LPVOID, wintypes.ULONG, ctypes.c_int], wintypes.LONG)
_get_security = _signature(_security, "GetSecurityInfo", [wintypes.HANDLE, ctypes.c_int,
    wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.LPVOID),
    ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.LPVOID),
    ctypes.POINTER(wintypes.LPVOID)], wintypes.DWORD)
_sd_length = _signature(_security, "GetSecurityDescriptorLength", [wintypes.LPVOID], wintypes.DWORD)
_sd_control = _signature(_security, "GetSecurityDescriptorControl", [wintypes.LPVOID,
    ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
_sd_owner = _signature(_security, "GetSecurityDescriptorOwner", [wintypes.LPVOID,
    ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL)
_sd_group = _signature(_security, "GetSecurityDescriptorGroup", [wintypes.LPVOID,
    ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL)
_sd_dacl = _signature(_security, "GetSecurityDescriptorDacl", [wintypes.LPVOID,
    ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(wintypes.LPVOID),
    ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL)
_get_ace = _signature(_security, "GetAce", [wintypes.LPVOID, wintypes.DWORD,
    ctypes.POINTER(wintypes.LPVOID)], wintypes.BOOL)
_sid_text = _signature(_security, "ConvertSidToStringSidW", [wintypes.LPVOID,
    ctypes.POINTER(wintypes.LPWSTR)], wintypes.BOOL)
_sddl_sd = _signature(_security, "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID),
     ctypes.POINTER(wintypes.ULONG)], wintypes.BOOL)
_sd_sddl = _signature(_security, "ConvertSecurityDescriptorToStringSecurityDescriptorW",
    [wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
     ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(wintypes.ULONG)], wintypes.BOOL)
_set_security = _signature(_security, "SetSecurityInfo", [wintypes.HANDLE, ctypes.c_int,
    wintypes.DWORD, wintypes.LPVOID, wintypes.LPVOID, wintypes.LPVOID, wintypes.LPVOID], wintypes.DWORD)
_open_token = _signature(_security, "OpenProcessToken", [wintypes.HANDLE, wintypes.DWORD,
    ctypes.POINTER(wintypes.HANDLE)], wintypes.BOOL)
_token_info = _signature(_security, "GetTokenInformation", [wintypes.HANDLE, ctypes.c_int,
    wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
_known_folder = _signature(_shell, "SHGetKnownFolderPath", [ctypes.POINTER(_Guid),
    wintypes.DWORD, wintypes.HANDLE, ctypes.POINTER(wintypes.LPWSTR)], wintypes.LONG)
_task_free = _signature(_ole, "CoTaskMemFree", [wintypes.LPVOID], None)


def _check(success):
    if not success:
        raise ctypes.WinError(ctypes.get_last_error())


class _Handle:
    def __init__(self, value):
        self.value = value

    def close(self):
        if self.value is not None:
            value, self.value = self.value, None
            _check(_close(value))

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        self.close()


def _information(handle):
    result = _FileInformation()
    _check(_info(handle, ctypes.byref(result)))
    return result


def _assert_kind(handle, *, directory):
    information = _information(handle)
    if information.FileAttributes & _ATTRIBUTE_REPARSE_POINT:
        raise OSError(errno.ELOOP, "refusing a reparse point at a protected filesystem boundary")
    if bool(information.FileAttributes & _ATTRIBUTE_DIRECTORY) != directory:
        raise ValueError("protected filesystem object has the wrong file type")
    return information


def _identity(handle):
    information = _information(handle)
    return information.VolumeSerialNumber, (information.FileIndexHigh << 32) | information.FileIndexLow


def _child(parent, name, *, directory=False, disposition=_OPEN, access=None,
           security=None, share=None):
    if not name or name in (".", "..") or any(c in name for c in "\\/\x00:"):
        raise ValueError("a protected relative operation requires one ordinary child name")
    length = len(name.encode("utf-16-le"))
    buffer = ctypes.create_unicode_buffer(name, length // 2 + 1)
    string = _UnicodeString(length, length + 2, ctypes.cast(buffer, wintypes.LPWSTR))
    attributes = _ObjectAttributes(ctypes.sizeof(_ObjectAttributes), parent,
        ctypes.pointer(string), 0x40, ctypes.cast(security, wintypes.LPVOID) if security else None, None)
    status, handle = _IoStatus(), wintypes.HANDLE()
    if access is None:
        access = _READ_CONTROL | _READ_ATTRIBUTES | _SYNCHRONIZE | (0x21 if directory else _READ_DATA)
    if share is None:
        share = 3 if directory else _SHARE_ALL  # a pinned parent cannot be renamed/deleted
    result = _nt_create(ctypes.byref(handle), access, ctypes.byref(attributes),
        ctypes.byref(status), None, 0x80, share, disposition,
        _SYNCHRONOUS | _OPEN_REPARSE_POINT | (_DIRECTORY if directory else _NON_DIRECTORY), None, 0)
    if result < 0:
        raise ctypes.WinError(_nt_error(result))
    opened = _Handle(handle.value)
    try:
        _assert_kind(opened.value, directory=directory)
    except BaseException:
        opened.close()
        raise
    return opened


@contextmanager
def _directory_chain(path, *, create=False, security=None):
    """Pin each component, refusing junctions before traversing the next one."""
    path = Path(os.path.abspath(path))
    if not path.is_absolute() or not path.anchor:
        raise ValueError("a protected directory must be absolute")
    with ExitStack() as stack:
        raw = _create_file(path.anchor, _READ_CONTROL | _READ_ATTRIBUTES | _SYNCHRONIZE | 0x21,
                           3, None, 3, 0x02000000 | 0x00200000, None)
        if raw == _INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        parent = stack.enter_context(_Handle(raw))
        _assert_kind(parent.value, directory=True)
        for name in path.parts[1:]:
            parent = stack.enter_context(_child(parent.value, name, directory=True,
                disposition=_OPEN_IF if create else _OPEN, security=security))
        yield parent.value


def _descriptor(handle):
    pointer = wintypes.LPVOID()
    result = _get_security(handle, 1, _OWNER | _GROUP | _DACL,
                           None, None, None, None, ctypes.byref(pointer))
    if result:
        raise ctypes.WinError(result)
    try:
        return ctypes.create_string_buffer(ctypes.string_at(pointer, _sd_length(pointer)))
    finally:
        _local_free(pointer)


def _descriptor_sddl(descriptor):
    text = wintypes.LPWSTR()
    _check(_sd_sddl(descriptor, 1, _OWNER | _GROUP | _DACL, ctypes.byref(text), None))
    try:
        return text.value
    finally:
        _local_free(ctypes.cast(text, wintypes.HLOCAL))


def _apply_descriptor(handle, descriptor):
    owner, group, dacl = wintypes.LPVOID(), wintypes.LPVOID(), wintypes.LPVOID()
    defaulted, present = wintypes.BOOL(), wintypes.BOOL()
    control, revision = wintypes.WORD(), wintypes.DWORD()
    _check(_sd_owner(descriptor, ctypes.byref(owner), ctypes.byref(defaulted)))
    _check(_sd_group(descriptor, ctypes.byref(group), ctypes.byref(defaulted)))
    _check(_sd_dacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)))
    _check(_sd_control(descriptor, ctypes.byref(control), ctypes.byref(revision)))
    protection = 0x80000000 if control.value & _DACL_PROTECTED else 0x20000000
    result = _set_security(handle, 1, _OWNER | _GROUP | _DACL | protection, owner, group, dacl, None)
    if result:
        raise ctypes.WinError(result)


def _security_identity(descriptor):
    """Exact owner/group/ACE bytes and DACL protection, without AI bookkeeping.

    Windows may change SE_DACL_AUTO_INHERITED when applying the same ACL to a
    newly created file. That flag records how inheritance was processed; it
    does not change the inherited flags, masks or trustees of the ACEs.
    """
    owner, group, dacl = wintypes.LPVOID(), wintypes.LPVOID(), wintypes.LPVOID()
    defaulted, present = wintypes.BOOL(), wintypes.BOOL()
    control, revision = wintypes.WORD(), wintypes.DWORD()
    _check(_sd_owner(descriptor, ctypes.byref(owner), ctypes.byref(defaulted)))
    _check(_sd_group(descriptor, ctypes.byref(group), ctypes.byref(defaulted)))
    _check(_sd_dacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)))
    _check(_sd_control(descriptor, ctypes.byref(control), ctypes.byref(revision)))
    acl_bytes = (ctypes.string_at(dacl, ctypes.cast(dacl, ctypes.POINTER(_Acl)).contents.AclSize)
                 if dacl.value else None)
    return (_sid_string(owner) if owner.value else None, _sid_string(group) if group.value else None,
            bool(present.value), control.value & _DACL_PROTECTED, acl_bytes)


def security_sddl(path):
    """Inspectable owner/group/DACL representation; never changes security."""
    with _directory_chain(Path(path).parent) as parent:
        with _child(parent, Path(path).name, directory=Path(path).is_dir()) as handle:
            return _descriptor_sddl(_descriptor(handle.value))


def is_reparse_path(path):
    """Inspect the entry itself, including directory junctions and dangling links."""
    try:
        return bool(os.lstat(path).st_file_attributes & _ATTRIBUTE_REPARSE_POINT)
    except FileNotFoundError:
        return False


def _sid_string(pointer):
    text = wintypes.LPWSTR()
    _check(_sid_text(pointer, ctypes.byref(text)))
    try:
        return text.value
    finally:
        _local_free(ctypes.cast(text, wintypes.HLOCAL))


def current_user_sid():
    """Read the native process token; HOME and environment overrides are ignored."""
    token = wintypes.HANDLE()
    _check(_open_token(_current_process(), 0x0008, ctypes.byref(token)))
    with _Handle(token.value):
        size = wintypes.DWORD()
        _token_info(token, 1, None, 0, ctypes.byref(size))
        if not size.value:
            raise ctypes.WinError(ctypes.get_last_error())
        data = ctypes.create_string_buffer(size.value)
        _check(_token_info(token, 1, data, size, ctypes.byref(size)))
        return _sid_string(ctypes.c_void_p.from_buffer(data).value)


def _private_descriptor():
    sid = current_user_sid()
    pointer = wintypes.LPVOID()
    _check(_sddl_sd(f"O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)", 1,
                    ctypes.byref(pointer), None))
    try:
        return ctypes.create_string_buffer(ctypes.string_at(pointer, _sd_length(pointer)))
    finally:
        _local_free(pointer)


def _assert_private(handle):
    descriptor = _descriptor(handle)
    owner, defaulted = wintypes.LPVOID(), wintypes.BOOL()
    _check(_sd_owner(descriptor, ctypes.byref(owner), ctypes.byref(defaulted)))
    sid = current_user_sid()
    control, revision = wintypes.WORD(), wintypes.DWORD()
    _check(_sd_control(descriptor, ctypes.byref(control), ctypes.byref(revision)))
    present, dacl = wintypes.BOOL(), wintypes.LPVOID()
    _check(_sd_dacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)))
    unsafe = (owner.value is None or _sid_string(owner) != sid
              or not control.value & _DACL_PROTECTED or not present.value or not dacl.value)
    owner_access = False
    if not unsafe:
        for index in range(ctypes.cast(dacl, ctypes.POINTER(_Acl)).contents.AceCount):
            ace = wintypes.LPVOID()
            _check(_get_ace(dacl, index, ctypes.byref(ace)))
            header = ctypes.cast(ace, ctypes.POINTER(_AceHeader)).contents
            # Only the expected ordinary allow ACEs are accepted; a null DACL,
            # broad trustee, inherited/unprotected authority, or exotic ACE fails closed.
            if header.AceType != 0 or header.AceSize < 16:
                unsafe = True
                break
            trustee = _sid_string(ace.value + 8)
            mask = wintypes.DWORD.from_address(ace.value + 4).value
            if trustee not in (sid, "S-1-5-18"):
                unsafe = True
                break
            if trustee == sid and mask & 0x001F01FF == 0x001F01FF:
                owner_access = True
    if unsafe or not owner_access:
        raise ValueError("unavailable: unsafe host observation authority owner or DACL")


def native_authority_directory():
    # FOLDERID_LocalAppData is resolved by Windows for the current token, not
    # from LOCALAPPDATA/USERPROFILE/HOME supplied by a project subprocess.
    identifier = _Guid(0xF1B32785, 0x6FBA, 0x4FCF,
                       (wintypes.BYTE * 8)(0x9D, 0x55, 0x7B, 0x8E, 0x7F, 0x15, 0x70, 0x91))
    result = wintypes.LPWSTR()
    status = _known_folder(ctypes.byref(identifier), 0, None, ctypes.byref(result))
    if status < 0:
        raise OSError(f"Windows could not resolve the native account state directory: HRESULT {status & 0xffffffff:x}")
    try:
        return Path(result.value) / "Nullius" / "capture-observation"
    finally:
        _task_free(ctypes.cast(result, wintypes.LPVOID))


def _write_all(handle, data):
    buffer = ctypes.create_string_buffer(data)
    offset = 0
    while offset < len(data):
        count = wintypes.DWORD()
        _check(_write(handle, ctypes.byref(buffer, offset), len(data) - offset,
                      ctypes.byref(count), None))
        if count.value == 0:
            raise OSError("Windows file write made no progress")
        offset += count.value
    _check(_flush(handle))


def _delete_open_file(handle):
    remove = wintypes.BOOL(True)
    _check(_set_info(handle, 4, ctypes.byref(remove), ctypes.sizeof(remove)))


def read_or_create_private_key(directory, *, create):
    """Read a 32-byte account-private, non-reparse, single-link authority key."""
    private = _private_descriptor()
    with _directory_chain(directory, create=create, security=private) as parent:
        _assert_private(parent)
        if create:
            try:
                created = _child(parent, "authority.key", disposition=_CREATE, security=private,
                    access=_READ_CONTROL | _READ_DATA | _WRITE_DATA | _READ_ATTRIBUTES | _DELETE | _SYNCHRONIZE,
                    share=0)
            except OSError as error:
                if getattr(error, "winerror", None) not in (32, 80, 183):
                    raise
            else:
                with created:
                    try:
                        _assert_private(created.value)
                        _write_all(created.value, secrets.token_bytes(32))
                    except BaseException:
                        _delete_open_file(created.value)
                        raise
        # Exclusive creation keeps incomplete key bytes unreadable. Concurrent
        # issuers wait only for that very short native write, never replace it.
        deadline = time.monotonic() + 2
        while True:
            try:
                opened = _child(parent, "authority.key", share=1)
                break
            except OSError as error:
                if getattr(error, "winerror", None) != 32 or time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)
        with opened:
            if _information(opened.value).NumberOfLinks != 1:
                raise ValueError("unavailable: unsafe host observation authority key has multiple links")
            _assert_private(opened.value)
            data, count = ctypes.create_string_buffer(33), wintypes.DWORD()
            _check(_read(opened.value, data, 33, ctypes.byref(count), None))
            if count.value != 32:
                raise ValueError("unavailable: invalid host observation authority key")
            return data.raw[:32]


def open_read_no_reparse(path):
    """Return a CRT fd with DELETE sharing so an atomic replacement may commit."""
    with _directory_chain(Path(path).parent) as parent:
        handle = _child(parent, Path(path).name)
    try:
        fd = msvcrt.open_osfhandle(handle.value, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        handle.close()
        raise
    handle.value = None  # ownership transferred to the CRT fd
    return fd


def _duplicate_fd(handle):
    duplicate = wintypes.HANDLE()
    process = _current_process()
    _check(_duplicate(process, handle, process, ctypes.byref(duplicate), 0, False, 2))
    try:
        return msvcrt.open_osfhandle(duplicate.value, os.O_WRONLY | os.O_BINARY)
    except BaseException:
        _close(duplicate)
        raise


def _rename_relative(handle, parent, name):
    class Rename(ctypes.Structure):
        _fields_ = [("ReplaceIfExists", wintypes.BOOL), ("RootDirectory", wintypes.HANDLE),
                    ("FileNameLength", wintypes.DWORD),
                    ("FileName", wintypes.WCHAR * (len(name.encode("utf-16-le")) // 2 + 1))]
    information = Rename(True, parent, len(name.encode("utf-16-le")), name)
    status = _IoStatus()
    # Windows 10's POSIX rename mode permits replacing the destination while
    # its validated read handle remains open. The source and destination handles
    # both explicitly share DELETE; no handle is dropped before validation.
    information.ReplaceIfExists = 3
    result = _nt_set_info(handle, ctypes.byref(status), ctypes.byref(information),
                          ctypes.sizeof(information), 65)
    if result < 0:
        raise ctypes.WinError(_nt_error(result))


def atomic_replace_text(path, text, *, newline=None, validated_fd=None, before_commit=None):
    """Replace through a pinned parent; preserve existing owner/group/DACL.

    Existing bytes are never changed in place. A read-only attribute, absent
    write permission, changed identity, reparse point, or failure to preserve
    security refuses the replacement. Staging-file cleanup uses its handle.
    File contents are flushed; Windows supplies no POSIX directory-fsync claim.
    """
    path = Path(path)
    with _directory_chain(path.parent) as parent:
        with ExitStack() as stack:
            try:
                source = stack.enter_context(_child(parent, path.name,
                    access=_READ_CONTROL | _READ_DATA | _WRITE_DATA | _READ_ATTRIBUTES | _SYNCHRONIZE))
            except FileNotFoundError:
                if validated_fd is not None:
                    raise FileExistsError(f"refusing to replace {path}: it changed identity during validation")
                source = None
            if source is not None:
                if _information(source.value).FileAttributes & _ATTRIBUTE_READONLY:
                    raise PermissionError(f"refusing to replace {path}: it is not writable")
                if validated_fd is not None and _identity(source.value) != _identity(msvcrt.get_osfhandle(validated_fd)):
                    raise FileExistsError(f"refusing to replace {path}: it changed identity during validation")
                security = _descriptor(source.value)
            else:
                security = None
            temporary = f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.partial"
            stage = stack.enter_context(_child(parent, temporary, disposition=_CREATE, security=security,
                access=_READ_CONTROL | _WRITE_DAC | _WRITE_OWNER | _READ_DATA | _WRITE_DATA
                       | _READ_ATTRIBUTES | _WRITE_ATTRIBUTES | _DELETE | _SYNCHRONIZE))
            renamed = False
            try:
                if security is not None:
                    # NT creation can merge inherited ACEs from the parent.
                    # Restore the descriptor through the staged handle before
                    # any private bytes are written, then verify the result.
                    if _security_identity(_descriptor(stage.value)) != _security_identity(security):
                        _apply_descriptor(stage.value, security)
                    if _security_identity(_descriptor(stage.value)) != _security_identity(security):
                        raise PermissionError("refusing to replace a file without preserving its Windows security descriptor")
                with os.fdopen(_duplicate_fd(stage.value), "w", encoding="utf-8", newline=newline) as stream:
                    stream.write(text)
                    stream.flush()
                    os.fsync(stream.fileno())
                if before_commit is not None:
                    before_commit()
                # Bind the final decision to the same source inode that supplied
                # the bytes and permissions, immediately before committing.
                try:
                    named = stack.enter_context(_child(parent, path.name))
                except FileNotFoundError:
                    if source is not None:
                        raise FileExistsError(f"refusing to replace {path}: it changed identity during validation")
                else:
                    if source is None or _identity(named.value) != _identity(source.value):
                        raise FileExistsError(f"refusing to replace {path}: it changed identity during validation")
                    if _information(named.value).FileAttributes & _ATTRIBUTE_READONLY:
                        raise PermissionError(f"refusing to replace {path}: it is not writable")
                _rename_relative(stage.value, parent, path.name)
                renamed = True
            finally:
                if not renamed:
                    _delete_open_file(stage.value)
