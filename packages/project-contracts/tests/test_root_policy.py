import sys
import os
import subprocess
import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_policy import assert_project_root_allowed, dev_repo_root


def _link(link: Path, target: Path | str, *, directory: bool = False) -> None:
    if os.name == "nt" and directory:
        target = Path(target)
        target = target if target.is_absolute() else link.parent / target
        subprocess.run([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "mklink", "/J",
                        str(link), str(target)], capture_output=True, check=True)
        return
    try:
        link.symlink_to(target, target_is_directory=directory)
    except OSError as error:
        if os.name == "nt" and error.winerror == 1314:
            raise unittest.SkipTest("file symlinks require Windows Developer Mode; directory aliases use native junctions")
        raise


class TestRootPolicy(unittest.TestCase):
    def test_real_project_rejects_repo_internal_root(self) -> None:
        repo_root = dev_repo_root()
        with self.assertRaisesRegex(ValueError, "outside the nullius dev repo"):
            assert_project_root_allowed(repo_root / "skills" / "research-team", project_policy="real_project")

    def test_maintainer_fixture_allows_repo_internal_tmp(self) -> None:
        repo_root = dev_repo_root()
        root = repo_root / "skills" / "research-team" / ".tmp" / "fixture"
        resolved = assert_project_root_allowed(root, project_policy="maintainer_fixture")
        self.assertEqual(resolved, root.resolve())

    def test_maintainer_fixture_rejects_other_repo_internal_root(self) -> None:
        repo_root = dev_repo_root()
        with self.assertRaisesRegex(ValueError, "allowed maintainer_fixture"):
            assert_project_root_allowed(repo_root / "packages" / "retired-provider", project_policy="maintainer_fixture")

    def test_alias_new_descendant_ancestor_and_root_refuse_before_writes(self) -> None:
        repo = dev_repo_root()
        with tempfile.TemporaryDirectory() as td:
            alias = Path(td) / 'checkout-alias'
            _link(alias, repo, directory=True)
            for candidate in (alias, alias / 'uncreated', repo.parent, Path(repo.anchor)):
                with self.assertRaises(ValueError):
                    assert_project_root_allowed(candidate, project_policy='real_project')
            self.assertFalse((alias / 'uncreated').exists())

    def test_case_alias_is_rejected_when_the_filesystem_resolves_it(self) -> None:
        repo = dev_repo_root()
        alias = repo.with_name(repo.name.upper())
        if alias.exists() and alias.samefile(repo):
            with self.assertRaises(ValueError):
                assert_project_root_allowed(alias)

    def test_other_checkout_alias_and_new_descendants_are_not_real_projects(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            repo = parent / "source"
            for name in ("orchestrator", "shared"):
                package = repo / "packages" / name
                package.mkdir(parents=True)
                (package / "package.json").write_text(json.dumps({"name": f"@nullius/{name}"}))
            (repo / "package.json").write_text(json.dumps({"name": "nullius"}))
            (repo / "pnpm-workspace.yaml").write_text("packages: [packages/*]\n")
            alias = parent / "source-alias"
            _link(alias, repo, directory=True)
            installation = parent / "copied-installation"
            installation.mkdir()
            for target in (repo, repo / "uncreated", alias / "uncreated"):
                with self.assertRaisesRegex(ValueError, "outside the nullius dev repo"):
                    assert_project_root_allowed(target, repo_root=installation)
            self.assertFalse((repo / "uncreated").exists())
            fixture = repo / "skills" / "research-team" / ".tmp" / "fixture"
            self.assertEqual(assert_project_root_allowed(fixture, repo_root=installation, project_policy="maintainer_fixture"), fixture.resolve())
            sibling = parent / "research"
            self.assertEqual(assert_project_root_allowed(sibling, repo_root=installation), sibling.resolve())

    def test_unrelated_workspace_is_not_mistaken_for_nullius_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "research"
            root.mkdir()
            (root / "package.json").write_text(json.dumps({"name": "research"}))
            (root / "pnpm-workspace.yaml").write_text("packages: [packages/*]\n")
            for name in ("orchestrator", "shared"):
                package = root / "packages" / name
                package.mkdir(parents=True)
                (package / "package.json").write_text(json.dumps({"name": f"@research/{name}"}))
            self.assertEqual(assert_project_root_allowed(root), root.resolve())

    def test_strict_utf8_json_identity_matches_typescript(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            root = parent / "source"
            installation = parent / "installation"
            installation.mkdir()
            for name in ("orchestrator", "shared"):
                package = root / "packages" / name
                package.mkdir(parents=True)
                (package / "package.json").write_text(json.dumps({"name": f"@nullius/{name}"}))
            (root / "pnpm-workspace.yaml").write_text("packages: [packages/*]\n")
            valid = '{"name":"nullius","note":"é"}'.encode("utf-8")
            malformed = [
                b'{"name":"nullius","note":"\xff"}',
                b'{"name":"nullius","unused":NaN}',
                b'{"name":"nullius","unused":Infinity}',
                b'{"name":"nullius","unused":-Infinity}',
                b'\xef\xbb\xbf' + valid,
            ]
            (root / "package.json").write_bytes(valid)
            with self.assertRaisesRegex(ValueError, "outside the nullius dev repo"):
                assert_project_root_allowed(root, repo_root=installation)
            for raw in malformed:
                (root / "package.json").write_bytes(raw)
                with self.assertRaisesRegex(ValueError, "ambiguous development-checkout metadata"):
                    assert_project_root_allowed(root, repo_root=installation)
            self.assertFalse((root / ".nullius").exists())

    def test_looping_and_dangling_markers_cannot_grant_admission(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            root = parent / "source"
            root.mkdir()
            installation = parent / "installation"
            installation.mkdir()
            (root / "package.json").write_text(json.dumps({"name": "nullius"}))
            (root / "pnpm-workspace.yaml").write_text("packages: [packages/*]\n")
            _link(root / "packages", "packages", directory=True)
            with self.assertRaisesRegex(ValueError, "ambiguous development-checkout metadata"):
                assert_project_root_allowed(root, repo_root=installation)
            ((root / "packages").rmdir if os.name == "nt" else (root / "packages").unlink)()
            for name in ("orchestrator", "shared"):
                package = root / "packages" / name
                package.mkdir(parents=True)
                (package / "package.json").write_text(json.dumps({"name": f"@nullius/{name}"}))
            (root / "package.json").unlink()
            _link(root / "package.json", "missing-package.json", directory=os.name == "nt")
            with self.assertRaisesRegex(ValueError, "ambiguous development-checkout metadata"):
                assert_project_root_allowed(root, repo_root=installation)
            self.assertFalse((root / ".nullius").exists())

    @unittest.skipIf(getattr(os, "geteuid", lambda: -1)() == 0, "root bypasses POSIX mode denial")
    def test_inaccessible_markers_cannot_grant_admission(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "source"
            packages = root / "packages"
            packages.mkdir(parents=True)
            installation = Path(td) / "installation"
            installation.mkdir()
            (root / "package.json").write_text(json.dumps({"name": "nullius"}))
            (root / "pnpm-workspace.yaml").write_text("packages: [packages/*]\n")
            sid = subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], text=True).strip() if os.name == "nt" else None
            if sid:
                subprocess.run(["icacls.exe", str(packages), "/deny", f"*{sid}:(OI)(CI)(RD)", "/Q"], check=True, capture_output=True)
            else:
                packages.chmod(0)
            try:
                with self.assertRaisesRegex(ValueError, "ambiguous development-checkout metadata"):
                    assert_project_root_allowed(root, repo_root=installation)
                self.assertFalse((root / ".nullius").exists())
            finally:
                if sid:
                    subprocess.run(["icacls.exe", str(packages), "/remove:d", f"*{sid}", "/Q"], check=True, capture_output=True)
                else:
                    packages.chmod(0o755)

    def test_real_project_allows_external_root(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            resolved = assert_project_root_allowed(root, project_policy="real_project")
            self.assertEqual(resolved, root.resolve())
