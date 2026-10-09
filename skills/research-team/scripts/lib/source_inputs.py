"""Bind discoverable literal command source and data dependencies before execution.

External packages remain environment identity. This bounded static closure is not
filesystem tracing: unresolved dynamic loads or reads are unavailable rather than
assumed complete. Explicit command data inputs enter as ordinary seeds.
"""
from __future__ import annotations

import ast
import re
import shlex
from pathlib import Path

_SOURCE_EXTS = {'.py', '.jl', '.sh', '.bash', '.zsh', '.r', '.R', '.m', '.wl', '.wls'}
_UNSUPPORTED_SOURCE_EXTS = {'.c', '.cc', '.cpp', '.h', '.hpp', '.f', '.f90', '.f95', '.rs', '.go', '.js', '.ts', '.ipynb', '.nb'}


def local_source_closure(seeds: list[Path], root: Path, *, cwd: Path | None = None) -> list[Path]:
    root = root.resolve()
    cwd = (cwd or root).resolve()
    if not cwd.is_relative_to(root):
        raise ValueError('unavailable command working directory outside project')
    pending = list(seeds)
    seen: set[Path] = set()

    def bind(value: str, base: Path) -> None:
        if not value or '\x00' in value:
            raise ValueError('unavailable empty or invalid literal command dependency')
        path = (base / value).resolve()
        try:
            regular = path.is_file()
        except OSError as error:
            raise ValueError('unavailable literal command dependency') from error
        if not path.is_relative_to(root) or not regular:
            raise ValueError(f'unavailable local command input: {path}')
        pending.append(path)

    def candidates(base: Path) -> list[Path]:
        return [p for p in (base.with_suffix('.py'), base / '__init__.py') if p.is_file()]

    def python_dependencies(path: Path, text: str) -> None:
        tree = ast.parse(text)
        values: dict[str, object] = {'__file__': str(path)}
        import_roots = {root, cwd, path.parent}
        # Census every Python binding, not merely simple assignment targets.
        # Only a unique module-level simple assignment/import is supported.
        # All other writes/scopes are opaque: values must never be borrowed
        # from a different binding or before a destructuring/rebinding event.
        io_attributes = {'open', 'read', 'read_text', 'read_bytes', 'readline', 'readlines', 'load', 'loadtxt', 'genfromtxt', 'read_csv', 'read_json', 'read_parquet', 'run_path', 'run_module', 'import_module', '__import__', 'exec', 'eval'}
        module_statements = {id(node) for node in tree.body}
        bindings: dict[str, list[tuple[str, ast.AST | None]]] = {}
        unresolved_bindings: set[str] = set()

        def record(name: str, kind: str, value: ast.AST | None = None) -> None:
            bindings.setdefault(name, []).append((kind, value))

        def target_names(target: ast.AST) -> set[str]:
            if isinstance(target, ast.Name):
                return {target.id}
            if isinstance(target, (ast.Tuple, ast.List)):
                return {name for element in target.elts for name in target_names(element)}
            if isinstance(target, ast.Starred):
                return target_names(target.value)
            # Attribute/subscript mutation invalidates the receiver's identity
            # as a supported imported constructor/module or literal path alias.
            value = getattr(target, 'value', None)
            while isinstance(value, (ast.Attribute, ast.Subscript)):
                value = value.value
            return {value.id} if isinstance(value, ast.Name) else set()

        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    supported = (id(node) in module_statements and isinstance(target, ast.Name) and node.value is not None
                                 and not (isinstance(node.value, ast.Attribute) and node.value.attr in io_attributes))
                    for name in target_names(target):
                        record(name, 'literal' if supported else 'opaque', node.value if supported else None)
            elif isinstance(node, (ast.AugAssign, ast.NamedExpr, ast.For, ast.AsyncFor, ast.comprehension)):
                for name in target_names(node.target):
                    record(name, 'opaque')
            elif isinstance(node, ast.Delete):
                for target in node.targets:
                    for name in target_names(target): record(name, 'opaque')
            elif isinstance(node, ast.arg):
                record(node.arg, 'opaque')
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                record(node.name, 'opaque')
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                if any(alias.name == '*' for alias in node.names):
                    raise ValueError('unavailable wildcard Python bindings')
                for alias in node.names:
                    name = alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                    record(name, 'import' if id(node) in module_statements else 'opaque')
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars is not None:
                        for name in target_names(item.optional_vars): record(name, 'opaque')
            elif isinstance(node, ast.ExceptHandler) and node.name:
                record(node.name, 'opaque')
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                for name in node.names: record(name, 'opaque')
            elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
                record(node.name, 'opaque')
            elif isinstance(node, ast.MatchMapping) and node.rest:
                record(node.rest, 'opaque')
            elif hasattr(ast, 'TypeAlias') and isinstance(node, ast.TypeAlias):
                for name in target_names(node.name): record(name, 'opaque')
        unresolved_bindings.update(name for name, events in bindings.items()
                                   if len(events) != 1 or events[0][0] == 'opaque')
        # __file__ is a runtime-supplied default, but any explicit rebinding
        # must not inherit that default before expression resolution.
        for name in bindings:
            values.pop(name, None)
        aliases = {a.asname or a.name: a.name for node in tree.body
                   if isinstance(node, ast.ImportFrom) for a in node.names
                   if (a.asname or a.name) not in unresolved_bindings}
        module_aliases = {a.asname or a.name.split('.')[0]: a.name for node in tree.body
                          if isinstance(node, ast.Import) for a in node.names}
        parents = {id(child): node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == 'sys' and any(a.name in ('path', 'modules') for a in node.names):
                raise ValueError('unavailable aliased Python import search/cache input')
            if not isinstance(node, ast.Attribute):
                continue
            if node.attr == '__path__':
                raise ValueError('unavailable dynamically modified package search input')
            if isinstance(node.value, ast.Name) and module_aliases.get(node.value.id) == 'sys':
                if node.attr == 'modules':
                    raise ValueError('unavailable Python import cache input')
                if node.attr == 'path':
                    parent = parents.get(id(node)); call = parents.get(id(parent))
                    if not (isinstance(parent, ast.Attribute) and parent.attr in ('insert', 'append')
                            and isinstance(call, ast.Call) and call.func is parent):
                        raise ValueError('unavailable aliased or mutated Python import search input')
        function_aliases = {name: events[0][1].id for name, events in bindings.items()
                            if name not in unresolved_bindings and events[0][0] == 'literal'
                            and isinstance(events[0][1], ast.Name)}

        def call_name(node) -> str:
            if isinstance(node.func, ast.Name) and node.func.id in unresolved_bindings:
                raise ValueError('unavailable opaque locally bound callable')
            if isinstance(node.func, ast.Attribute):
                receiver = node.func.value
                while isinstance(receiver, (ast.Attribute, ast.Subscript)):
                    receiver = receiver.value
                if isinstance(receiver, ast.Name) and receiver.id in unresolved_bindings and node.func.attr in ('Path', 'cwd', 'resolve', 'absolute', 'open', 'read', 'read_text', 'read_bytes', 'readline', 'readlines', 'import_module', 'run_module'):
                    raise ValueError('unavailable rebound Python load/path receiver')
            name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ''
            visited = set()
            while name in function_aliases and name not in visited:
                visited.add(name); name = function_aliases[name]
                if name in unresolved_bindings:
                    raise ValueError('unavailable rebound Python callable alias')
            return aliases.get(name, name)

        def literal(node):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return node.value
            if isinstance(node, ast.Name):
                return None if node.id in unresolved_bindings else values.get(node.id)
            if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Div)):
                left, right = literal(node.left), literal(node.right)
                if isinstance(left, str) and isinstance(right, str):
                    return left + right if isinstance(node.op, ast.Add) else str(Path(left) / right)
            if isinstance(node, ast.Attribute) and node.attr == 'parent':
                value = literal(node.value)
                return str(Path(value).parent) if isinstance(value, str) else None
            if isinstance(node, ast.Call):
                name = call_name(node)
                if name in ('Path', 'str') and len(node.args) == 1 and not node.keywords:
                    return literal(node.args[0])
                if name == 'cwd' and not node.args and not node.keywords:
                    return str(cwd)
                if name in ('resolve', 'absolute') and isinstance(node.func, ast.Attribute) and not node.args and not node.keywords:
                    value = literal(node.func.value)
                    return str((cwd / value).resolve()) if isinstance(value, str) else None
                if name == 'open':
                    receiver = literal(node.func.value) if isinstance(node.func, ast.Attribute) else None
                    if isinstance(receiver, str):
                        return receiver
                    argument = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == 'file'), None)
                    return literal(argument)
            return None

        assignments = {name: events[0][1] for name, events in bindings.items()
                       if name not in unresolved_bindings and events[0][0] == 'literal'}
        for _ in range(len(assignments) + 1):
            for name, expression in assignments.items():
                values[name] = literal(expression)

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            receiver = node.func.value
            if isinstance(receiver, ast.Attribute) and receiver.attr == 'path' and isinstance(receiver.value, ast.Name) and module_aliases.get(receiver.value.id, receiver.value.id) == 'sys' and node.func.attr in ('insert', 'append'):
                if receiver.value.id in unresolved_bindings:
                    raise ValueError('unavailable rebound Python import-search receiver')
                argument = node.args[-1] if node.args else None
                value = literal(argument)
                if not isinstance(value, str):
                    raise ValueError('unavailable nonliteral Python import search path')
                base = (cwd / value).resolve()
                if not base.is_relative_to(root) or not base.is_dir():
                    raise ValueError('unavailable Python import search path outside project')
                import_roots.add(base)

        for node in ast.walk(tree):
            names: list[str] = []
            base = root
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    base = path.parent
                    for _ in range(node.level - 1):
                        base = base.parent
                    if not base.is_relative_to(root):
                        raise ValueError('unavailable relative dependency outside project')
                mod = node.module or ''
                names = ([mod] if mod else []) + [f'{mod}.{a.name}'.strip('.') for a in node.names if a.name != '*']
            elif isinstance(node, ast.Call):
                name = call_name(node)
                if name in ('import_module', '__import__', 'run_module'):
                    value = literal(node.args[0]) if node.args else None
                    if not isinstance(value, str):
                        raise ValueError('unavailable nonliteral dynamic source dependency')
                    names = [value]
                elif name in ('exec', 'eval', 'getattr', '__getattribute__', 'setattr', 'globals', 'locals', 'vars',
                              'Popen', 'system', 'popen', 'check_call', 'check_output', 'glob', 'rglob', 'iterdir', 'walk', 'scandir', 'listdir') or name in ('run', 'call') and isinstance(node.func, ast.Attribute):
                    raise ValueError('unavailable dynamically evaluated command source')
                elif name in ('run_path', 'execfile', 'loadtxt', 'genfromtxt', 'read_csv', 'read_json', 'read_parquet', 'load', 'open', 'read_text', 'read_bytes', 'read', 'readline', 'readlines'):
                    if name == 'open':
                        receiver = literal(node.func.value) if isinstance(node.func, ast.Attribute) else None
                        path_method = isinstance(receiver, str)
                        mode_index = 0 if path_method else 1
                        mode = literal(node.args[mode_index]) if len(node.args) > mode_index else next((literal(k.value) for k in node.keywords if k.arg == 'mode'), 'r')
                        if not isinstance(mode, str):
                            raise ValueError('unavailable nonliteral file access mode')
                        if any(flag in mode for flag in 'wax') and '+' not in mode:
                            continue
                    argument = node.func.value if (name in ('read_text', 'read_bytes', 'read', 'readline', 'readlines') or name == 'open' and path_method) and isinstance(node.func, ast.Attribute) else node.args[0] if node.args else next((k.value for k in node.keywords if k.arg in ('file', 'fname', 'filepath_or_buffer', 'path_or_buf')), None)
                    value = literal(argument)
                    if not isinstance(value, str):
                        raise ValueError(f'unavailable nonliteral command read/load: {name}')
                    bind(value, cwd)
            for name in names:
                if name.startswith('.'):
                    raise ValueError('unavailable dynamically relative source dependency')
                parts = name.split('.')
                for search in import_roots if base == root else {base}:
                    for count in range(1, len(parts) + 1):
                        pending.extend(candidates(search.joinpath(*parts[:count])))

    def other_dependencies(path: Path, text: str) -> None:
        ext = path.suffix
        if ext in {'.sh', '.bash', '.zsh'}:
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith('#'):
                    continue
                if re.search(r'(?:^|[;\s])(?:eval|exec|sh|bash|zsh|python\d*|julia|Rscript|wolframscript)\b', stripped) or '`' in stripped or '$(' in stripped:
                    raise ValueError('unavailable delegated or dynamically evaluated shell source')
                match = re.search(r'(?:^|[;\s])(?:source|\.)\s+([^;]+)', stripped)
                if match:
                    tokens = shlex.split(match.group(1), comments=True)
                    if len(tokens) != 1 or any(c in tokens[0] for c in '$`*?[]{}'):
                        raise ValueError('unavailable nonliteral shell source dependency')
                    bind(tokens[0], cwd)
                read = re.fullmatch(r'(?:cat|head|tail|wc)\s+(.+)', stripped)
                if read:
                    tokens = shlex.split(read.group(1), comments=True)
                    if not tokens or any(token.startswith('-') or any(c in token for c in '$`*?[]{}|;<>&') for token in tokens):
                        raise ValueError('unavailable nonliteral shell runtime read')
                    for token in tokens:
                        bind(token, cwd)
                    continue
                if re.search(r'(?:^|[;\s])(?:cat|head|tail|wc|grep|awk|sed|read)\b|(?<![<>])<(?![<>])', stripped):
                    raise ValueError('unavailable shell runtime read; use a bound source/data adapter')
            return
        clean = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
        if ext == '.jl':
            if re.search(r'\b(?:eval|include_string|invokelatest|run|evalfile)\s*\(|@eval\b|\bPkg\.(?:activate|develop|add)\s*\(', clean):
                raise ValueError('unavailable dynamically evaluated or activated local source')
            # Local packages are source dependencies as well as includes. Their
            # project metadata is an input; external package internals remain
            # the explicitly documented environment-identity boundary.
            package_name = None
            project_file = root / 'Project.toml'
            if project_file.is_file():
                import tomllib
                package_name = tomllib.loads(project_file.read_text(encoding='utf-8')).get('name')
            for statement in re.finditer(r'^\s*(?:using|import)\s+([^\n;]+)', clean, re.MULTILINE):
                names = statement.group(1).split(':', 1)[0]
                for name in names.split(','):
                    name = name.strip().split(' as ', 1)[0].split('.', 1)[0]
                    if not re.fullmatch(r'[A-Za-z_]\w*', name):
                        raise ValueError('unavailable unresolved local package import')
                    local = [base / f'{name}.jl' for base in (path.parent, cwd, root / 'src')]
                    found = [candidate for candidate in local if candidate.is_file()]
                    if package_name == name and not found:
                        raise ValueError('unavailable local package entry source')
                    pending.extend(found)
                    if found:
                        for metadata in (project_file, root / 'Manifest.toml'):
                            if metadata.is_file():
                                pending.append(metadata)
            patterns = [(r'\b(?:include|includet)\s*\(', path.parent),
                        (r'\b(?:read|readlines|readchomp|readdlm|open|load)\s*\(', cwd)]
        elif ext in {'.r', '.R'}:
            if re.search(r'\b(?:eval|parse|system|system2|do\.call)\s*\(', clean):
                raise ValueError('unavailable dynamically evaluated source/data input')
            patterns = [(r'\b(?:source|sys\.source|readLines|readRDS|read\.csv|read\.table|scan|load)\s*\(', cwd)]
        else:
            if re.search(r'\b(?:ToExpression|Run|RunProcess|Evaluate)\s*\[', clean):
                raise ValueError('unavailable dynamically evaluated source/data input')
            patterns = [(r'\b(?:Get|Import|ReadList|OpenRead)\s*\[', cwd)]
        for pattern, base in patterns:
            for match in re.finditer(pattern, clean):
                remainder = clean[match.end():].lstrip()
                literal_match = re.match(r'(["\'])(.*?)\1\s*(?:[,\)\]])', remainder, re.DOTALL)
                if not literal_match or '\\' in literal_match.group(2):
                    raise ValueError('unavailable nonliteral local source/data dependency')
                bind(literal_match.group(2), base)
        if ext in {'.m', '.wl', '.wls'}:
            for match in re.finditer(r'<<\s*([^\s;\]]+)', clean):
                token = match.group(1)
                if not re.fullmatch(r'[A-Za-z0-9_./-]+', token):
                    raise ValueError('unavailable nonliteral local source dependency')
                bind(token, cwd)

    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f'unavailable local command input: {path}')
        seen.add(path)
        if len(seen) > 500 or path.stat().st_size > 2_000_000:
            raise ValueError('unavailable: complete command input closure exceeds resource budget')
        if path.suffix in _UNSUPPORTED_SOURCE_EXTS:
            raise ValueError('unavailable: source language dependency closure is not supported')
        if path.suffix in _SOURCE_EXTS:
            text = path.read_text(encoding='utf-8')
            if path.suffix == '.py':
                python_dependencies(path, text)
            else:
                other_dependencies(path, text)
    return sorted(seen)
