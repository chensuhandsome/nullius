"""Native Windows protection checks; POSIX keeps its existing writer tests."""
import ctypes
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import stat
import subprocess
import sys

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="native Windows filesystem contracts")
if os.name == "nt":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from nullius_windows import filesystem as fs


def test_atomic_replacement_preserves_security_and_exact_text(tmp_path):
    target = tmp_path / "contract.txt"
    target.write_bytes(b"original\r\n")
    security = fs.security_sddl(target)
    fs.atomic_replace_text(target, "preserved\r\nnew line\n", newline="")
    assert target.read_bytes() == b"preserved\r\nnew line\n"
    assert fs.security_sddl(target) == security
    assert not list(tmp_path.glob("*.partial"))


def test_validated_descriptor_cannot_authorize_a_replacement_file(tmp_path):
    target = tmp_path / "contract.txt"
    target.write_text("template", encoding="utf-8")
    fd = fs.open_read_no_reparse(target)
    try:
        target.rename(tmp_path / "old.txt")
        target.write_text("curated contract", encoding="utf-8")
        with pytest.raises(FileExistsError, match="changed identity"):
            fs.atomic_replace_text(target, "derived", validated_fd=fd)
        assert target.read_text(encoding="utf-8") == "curated contract"
    finally:
        os.close(fd)


def test_readonly_file_is_not_replaced(tmp_path):
    target = tmp_path / "contract.txt"
    target.write_bytes(b"owner data")
    target.chmod(stat.S_IREAD)
    try:
        with pytest.raises(PermissionError):
            fs.atomic_replace_text(target, "derived")
        assert target.read_bytes() == b"owner data"
        assert not list(tmp_path.glob("*.partial"))
    finally:
        target.chmod(stat.S_IREAD | stat.S_IWRITE)


def test_parent_is_pinned_against_rename_until_commit(tmp_path):
    parent = tmp_path / "owned"
    parent.mkdir()
    target = parent / "contract.txt"
    target.write_text("before", encoding="utf-8")

    def try_redirect():
        with pytest.raises(OSError) as error:
            parent.rename(tmp_path / "moved")
        assert error.value.winerror in (5, 32)

    fs.atomic_replace_text(target, "after", before_commit=try_redirect)
    assert target.read_text(encoding="utf-8") == "after"
    assert not (tmp_path / "moved").exists()


def test_destination_swapped_during_staging_is_not_overwritten(tmp_path):
    target = tmp_path / "contract.txt"
    target.write_text("template", encoding="utf-8")

    def replace_destination():
        target.rename(tmp_path / "old.txt")
        target.write_text("curated contract", encoding="utf-8")

    with pytest.raises(FileExistsError, match="changed identity"):
        fs.atomic_replace_text(target, "derived", before_commit=replace_destination)
    assert target.read_text(encoding="utf-8") == "curated contract"
    assert not list(tmp_path.glob("*.partial"))


def test_cleanup_removes_its_own_stage_and_keeps_a_foreign_name(tmp_path):
    target = tmp_path / "contract.txt"
    target.write_text("original", encoding="utf-8")
    replacement = []

    def substitute_stage_name():
        staged, = tmp_path.glob("*.partial")
        staged.rename(tmp_path / "moved-stage")
        staged.write_text("foreign file", encoding="utf-8")
        replacement.append(staged)
        raise RuntimeError("abort before commit")

    with pytest.raises(RuntimeError, match="abort before commit"):
        fs.atomic_replace_text(target, "new", before_commit=substitute_stage_name)
    assert replacement[0].read_text(encoding="utf-8") == "foreign file"
    assert not (tmp_path / "moved-stage").exists()
    assert target.read_text(encoding="utf-8") == "original"


def test_junction_parent_is_refused_before_any_write(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    target = real / "contract.txt"
    target.write_text("owned", encoding="utf-8")
    link = tmp_path / "alias"
    subprocess.run([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "mklink", "/J",
                    str(link), str(real)], capture_output=True, check=True)
    assert fs.is_reparse_path(link)
    assert not fs.is_reparse_path(target)
    assert not fs.is_reparse_path(tmp_path / "missing")
    with pytest.raises(OSError, match="reparse point"):
        fs.atomic_replace_text(link / target.name, "derived")
    assert target.read_text(encoding="utf-8") == "owned"
    assert not list(real.glob("*.partial"))


def test_private_key_is_stable_and_protected(tmp_path):
    authority = tmp_path / "native-host" / "authority"
    first = fs.read_or_create_private_key(authority, create=True)
    assert len(first) == 32
    assert fs.read_or_create_private_key(authority, create=True) == first
    assert fs.read_or_create_private_key(authority, create=False) == first
    for path in (authority, authority / "authority.key"):
        sddl = fs.security_sddl(path)
        assert "D:P" in sddl
        assert fs.current_user_sid() in sddl
        assert ";;;WD)" not in sddl


def test_private_authority_refuses_an_existing_unprotected_directory(tmp_path):
    authority = tmp_path / "authority"
    authority.mkdir()
    with pytest.raises(ValueError, match="unsafe host"):
        fs.read_or_create_private_key(authority, create=True)
    assert not (authority / "authority.key").exists()


def test_private_authority_refuses_a_key_with_a_second_link(tmp_path):
    authority = tmp_path / "native-host" / "authority"
    fs.read_or_create_private_key(authority, create=True)
    os.link(authority / "authority.key", tmp_path / "key-alias")
    with pytest.raises(ValueError, match="multiple links"):
        fs.read_or_create_private_key(authority, create=False)


def test_private_authority_refuses_broad_access_without_repairing_it(tmp_path):
    authority = tmp_path / "native-host" / "authority"
    fs.read_or_create_private_key(authority, create=True)
    descriptor = ctypes.c_void_p()
    fs._check(fs._sddl_sd(
        f"O:{fs.current_user_sid()}D:P(A;OICI;FA;;;{fs.current_user_sid()})(A;OICI;FA;;;WD)",
        1, ctypes.byref(descriptor), None))
    set_security = fs._signature(fs._security, "SetFileSecurityW",
        [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_void_p], ctypes.c_int)
    try:
        fs._check(set_security(str(authority), 0x80000004, descriptor))
    finally:
        fs._local_free(descriptor)
    before = fs.security_sddl(authority)
    with pytest.raises(ValueError, match="unsafe host"):
        fs.read_or_create_private_key(authority, create=True)
    assert fs.security_sddl(authority) == before


def test_native_authority_ignores_project_supplied_home(monkeypatch, tmp_path):
    expected = fs.native_authority_directory()
    for name in ("HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_STATE_HOME"):
        monkeypatch.setenv(name, str(tmp_path / "untrusted"))
    assert fs.native_authority_directory() == expected


def test_non_bmp_file_and_directory_names_are_not_truncated(tmp_path):
    parent = tmp_path / "project-\U0001f52c"
    parent.mkdir()
    target = parent / "contract-\U0001f680.txt"
    target.write_text("original", encoding="utf-8")
    fd = fs.open_read_no_reparse(target)
    try:
        fs.atomic_replace_text(target, "preserved \U0001f52c\n", newline="", validated_fd=fd)
    finally:
        os.close(fd)
    assert target.read_bytes() == "preserved \U0001f52c\n".encode("utf-8")


def test_private_destination_keeps_its_protected_owner_only_acl(tmp_path):
    target = tmp_path / "private-contract.txt"
    target.write_text("private source", encoding="utf-8")
    descriptor = fs._private_descriptor()
    set_security = fs._signature(fs._security, "SetFileSecurityW",
        [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_void_p], ctypes.c_int)
    fs._check(set_security(str(target), 0x80000005, descriptor))
    before = fs.security_sddl(target)
    assert "D:P" in before
    fs.atomic_replace_text(target, "private replacement", newline="")
    assert fs.security_sddl(target) == before
    assert target.read_text(encoding="utf-8") == "private replacement"


def test_concurrent_issuers_share_one_complete_native_key(tmp_path):
    authority = tmp_path / "native-host" / "authority"
    with ThreadPoolExecutor(max_workers=8) as pool:
        keys = list(pool.map(lambda _: fs.read_or_create_private_key(authority, create=True), range(16)))
    assert len(set(keys)) == 1
    assert len(keys[0]) == 32


def test_failed_key_creation_removes_its_own_incomplete_file(tmp_path, monkeypatch):
    authority = tmp_path / "native-host" / "authority"

    def fail_write(handle, data):
        raise RuntimeError("injected key write failure")

    monkeypatch.setattr(fs, "_write_all", fail_write)
    with pytest.raises(RuntimeError, match="injected key write failure"):
        fs.read_or_create_private_key(authority, create=True)
    assert not (authority / "authority.key").exists()


def test_invalid_existing_key_is_refused_without_replacing_it(tmp_path):
    authority = tmp_path / "native-host" / "authority"
    fs.read_or_create_private_key(authority, create=True)
    key = authority / "authority.key"
    key.write_bytes(b"invalid")
    with pytest.raises(ValueError, match="invalid host"):
        fs.read_or_create_private_key(authority, create=True)
    assert key.read_bytes() == b"invalid"
