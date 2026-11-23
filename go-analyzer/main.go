// go-analyzer is spawned as a subprocess by lib/go-analyzer.ts. It reads a JSON array of absolute
// .go file paths on stdin and emits JSON candidates for the mode given as its first argument:
//
//   - inline: groups files by directory (Go's package boundary) and reports the `inline` check's
//     two hard, non-tunable rules — a top-level func used from exactly one place in its package,
//     and a top-level const whose every use sits inside the same single enclosing function
//   - if-init: every `if` statement with an init statement, with its source text and line span
//   - multi-assign: every assignment or var/const spec pairing several names with as many values
//     (`x, y = 1, 2`), minus swaps and `for` init/post statements, plus every grouped
//     function-local `var (...)` / `const (...)` block declaring several specs
//   - single-letter: every one-character name bound by `:=`, var/const, range, or a func parameter/result
//   - dead-code: top-level funcs, consts, vars and types with no reference from non-test code, split
//     into never referenced at all and referenced only from _test.go files. Unlike the other modes it
//     reads every file at once: an exported name is looked up through the imports of every scanned file
//     (resolved via go.mod), so a use in another package counts
//
// Tunable filtering (--max-lines, --max-length, ...) stays in commands/*.ts, same as the ts-morph path.
//
// This is identifier-name matching, not symbol resolution (no go/types, no network/module deps, so
// it runs on any package without needing it to build) — a local variable that shadows a top-level
// name can be miscounted as a reference. Treat results as candidates, not verdicts, same as every
// other check in this tool.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type funcCandidate struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	File      string `json:"file"`
	Line      int    `json:"line"`
	BodyLines int    `json:"bodyLines"`
	Exported  bool   `json:"exported"`
}

type constCandidate struct {
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	File       string `json:"file"`
	Line       int    `json:"line"`
	Exported   bool   `json:"exported"`
	UseCount   int    `json:"useCount"`
	UsedIn     string `json:"usedIn"`
	UsedInLine int    `json:"usedInLine"`
}

type spanCandidate struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine"`
	Text    string `json:"text"`
}

type bindingCandidate struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	// Type is the parameter's declared type as source text; empty for variables
	Type string `json:"type,omitempty"`
	// Loop marks a three-clause `for` init variable or a `range` key
	Loop bool `json:"loop,omitempty"`
	// Comparator marks a parameter of a func literal taking exactly `(a, b T)`
	Comparator bool `json:"comparator,omitempty"`
}

type deadCandidate struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Exported bool   `json:"exported"`
	// TestRefs is 0 for a name nothing references; otherwise the number of _test.go references
	TestRefs int    `json:"testRefs"`
	TestFile string `json:"testFile,omitempty"`
	TestLine int    `json:"testLine,omitempty"`
}

type funcDecl struct {
	name      string
	file      string
	line      int
	bodyLines int
	exported  bool
	ident     *ast.Ident
	refCount  int
}

type refOccurrence struct {
	hasEnclosing bool
	funcName     string
	funcLine     int
}

type constDecl struct {
	name     string
	file     string
	line     int
	exported bool
	ident    *ast.Ident
	refs     []refOccurrence
}

type frame struct {
	isFunc   bool
	funcName string
	funcLine int
}

func exported(name string) bool {
	r := []rune(name)
	return len(r) > 0 && unicode.IsUpper(r[0])
}

func bodyLineCount(fset *token.FileSet, body *ast.BlockStmt) int {
	if len(body.List) == 0 {
		return 0
	}
	first := body.List[0]
	last := body.List[len(body.List)-1]
	return fset.Position(last.End()).Line - fset.Position(first.Pos()).Line + 1
}

// marks identifiers that are declarations/selectors rather than uses of a package-level name:
// struct/interface/func-signature field names, import aliases, labels, and `:=` LHS idents. Skipping
// these avoids the most common false positives from name-only (non-type-checked) matching.
func declaredIdents(file *ast.File) map[*ast.Ident]bool {
	skip := map[*ast.Ident]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.SelectorExpr:
			skip[node.Sel] = true
		case *ast.Field:
			for _, id := range node.Names {
				skip[id] = true
			}
		case *ast.ImportSpec:
			if node.Name != nil {
				skip[node.Name] = true
			}
		case *ast.LabeledStmt:
			skip[node.Label] = true
		case *ast.BranchStmt:
			if node.Label != nil {
				skip[node.Label] = true
			}
		case *ast.ValueSpec:
			for _, id := range node.Names {
				skip[id] = true
			}
		case *ast.TypeSpec:
			skip[node.Name] = true
		case *ast.AssignStmt:
			if node.Tok == token.DEFINE {
				for _, lhs := range node.Lhs {
					if id, ok := lhs.(*ast.Ident); ok {
						skip[id] = true
					}
				}
			}
		}
		return true
	})
	return skip
}

func analyzePackage(fset *token.FileSet, files []*ast.File, paths []string) []any {
	funcs := map[string]*funcDecl{}
	consts := map[string]*constDecl{}

	for i, file := range files {
		path := paths[i]
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if d.Recv != nil || d.Body == nil {
					continue
				}
				funcs[d.Name.Name] = &funcDecl{
					name:      d.Name.Name,
					file:      path,
					line:      fset.Position(d.Name.Pos()).Line,
					bodyLines: bodyLineCount(fset, d.Body),
					exported:  exported(d.Name.Name),
					ident:     d.Name,
				}
			case *ast.GenDecl:
				if d.Tok != token.CONST {
					continue
				}
				for _, spec := range d.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok || len(vs.Names) != 1 {
						continue
					}
					name := vs.Names[0]
					if name.Name == "_" {
						continue
					}
					consts[name.Name] = &constDecl{
						name:     name.Name,
						file:     path,
						line:     fset.Position(name.Pos()).Line,
						exported: exported(name.Name),
						ident:    name,
					}
				}
			}
		}
	}

	for _, file := range files {
		skip := declaredIdents(file)
		var stack []frame
		cur := frame{}
		ast.Inspect(file, func(n ast.Node) bool {
			if n == nil {
				cur = stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				return true
			}
			next := cur
			switch node := n.(type) {
			case *ast.FuncDecl:
				next = frame{isFunc: true, funcName: node.Name.Name, funcLine: fset.Position(node.Name.Pos()).Line}
			case *ast.FuncLit:
				line := fset.Position(node.Pos()).Line
				next = frame{isFunc: true, funcName: fmt.Sprintf("func literal at :%d", line), funcLine: line}
			case *ast.Ident:
				if !skip[node] {
					if f, ok := funcs[node.Name]; ok && node != f.ident {
						f.refCount++
					}
					if c, ok := consts[node.Name]; ok && node != c.ident {
						c.refs = append(c.refs, refOccurrence{hasEnclosing: cur.isFunc, funcName: cur.funcName, funcLine: cur.funcLine})
					}
				}
			}
			stack = append(stack, cur)
			cur = next
			return true
		})
	}

	var out []any
	for _, f := range funcs {
		if f.refCount != 1 {
			continue
		}
		out = append(out, funcCandidate{Kind: "func", Name: f.name, File: f.file, Line: f.line, BodyLines: f.bodyLines, Exported: f.exported})
	}
	for _, c := range consts {
		if len(c.refs) == 0 {
			continue
		}
		first := c.refs[0]
		singleEnclosing := first.hasEnclosing
		for _, r := range c.refs {
			if !r.hasEnclosing || r.funcName != first.funcName || r.funcLine != first.funcLine {
				singleEnclosing = false
				break
			}
		}
		if !singleEnclosing {
			continue
		}
		out = append(out, constCandidate{
			Kind: "const", Name: c.name, File: c.file, Line: c.line, Exported: c.exported,
			UseCount: len(c.refs), UsedIn: first.funcName, UsedInLine: first.funcLine,
		})
	}
	return out
}

func span(fset *token.FileSet, path string, src []byte, node ast.Node) spanCandidate {
	start := fset.Position(node.Pos())
	end := fset.Position(node.End())
	return spanCandidate{File: path, Line: start.Line, EndLine: end.Line, Text: string(src[start.Offset:end.Offset])}
}

func ifInits(fset *token.FileSet, file *ast.File, path string, src []byte) []any {
	var out []any
	ast.Inspect(file, func(n ast.Node) bool {
		stmt, ok := n.(*ast.IfStmt)
		if !ok || stmt.Init == nil {
			return true
		}
		out = append(out, span(fset, path, src, stmt.Init))
		return true
	})
	return out
}

func runPerFile(paths []string, analyze func(*token.FileSet, *ast.File, string, []byte) []any) []any {
	fset := token.NewFileSet()
	var results []any
	for _, p := range paths {
		src, err := os.ReadFile(p)
		if err != nil {
			fmt.Fprintf(os.Stderr, "go-analyzer: skipping %s: %v\n", p, err)
			continue
		}
		f, err := parser.ParseFile(fset, p, src, 0)
		if err != nil {
			fmt.Fprintf(os.Stderr, "go-analyzer: skipping %s: %v\n", p, err)
			continue
		}
		results = append(results, analyze(fset, f, p, src)...)
	}
	return results
}

// a swap/rotation (`a, b = b, a`) needs the parallel assignment — split up, it needs a temporary
func isPermutation(src []byte, fset *token.FileSet, lhs, rhs []ast.Expr) bool {
	text := func(e ast.Expr) string {
		return string(src[fset.Position(e.Pos()).Offset:fset.Position(e.End()).Offset])
	}
	counts := map[string]int{}
	for _, e := range lhs {
		counts[text(e)]++
	}
	for _, e := range rhs {
		counts[text(e)]--
	}
	for _, n := range counts {
		if n != 0 {
			return false
		}
	}
	return true
}

// a `const (...)` block that leans on iota or an implicit repeat is one enum, not several declarations
func isUnrelatedGroup(decl *ast.GenDecl) bool {
	switch decl.Tok {
	case token.VAR:
		return true
	case token.CONST:
		for _, spec := range decl.Specs {
			if len(spec.(*ast.ValueSpec).Values) == 0 {
				return false
			}
		}
		return !mentionsIota(decl)
	}
	return false
}

func multiAssigns(fset *token.FileSet, file *ast.File, path string, src []byte) []any {
	var out []any
	// `for i, j := 0, n-1; i < j; i, j = i+1, j-1` — a for clause has room for only one statement each
	inForClause := map[ast.Stmt]bool{}
	// package-level groups are left alone: sentinel errors and the like read fine as one block
	topLevel := map[ast.Decl]bool{}
	for _, decl := range file.Decls {
		topLevel[decl] = true
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.ForStmt:
			inForClause[node.Init] = true
			inForClause[node.Post] = true
		case *ast.AssignStmt:
			if len(node.Lhs) > 1 && len(node.Rhs) == len(node.Lhs) && !inForClause[node] && !isPermutation(src, fset, node.Lhs, node.Rhs) {
				out = append(out, span(fset, path, src, node))
			}
		case *ast.GenDecl:
			if node.Lparen.IsValid() && len(node.Specs) > 1 && !topLevel[node] && isUnrelatedGroup(node) {
				out = append(out, span(fset, path, src, node))
			}
		case *ast.ValueSpec:
			if len(node.Names) > 1 && len(node.Values) == len(node.Names) {
				out = append(out, span(fset, path, src, node))
			}
		}
		return true
	})
	return out
}

// receivers are left out: Go convention asks for one- or two-letter receiver names (`func (s *Server)`)
func singleLetters(fset *token.FileSet, file *ast.File, path string, _ []byte) []any {
	var out []any
	loopVars := map[*ast.Ident]bool{}
	comparators := map[*ast.FuncType]bool{}
	add := func(kind string, id *ast.Ident, typ ast.Expr, comparator bool) {
		if utf8.RuneCountInString(id.Name) != 1 {
			return
		}
		candidate := bindingCandidate{File: path, Line: fset.Position(id.Pos()).Line, Kind: kind, Name: id.Name, Loop: loopVars[id], Comparator: comparator}
		if typ != nil {
			candidate.Type = types.ExprString(typ)
		}
		out = append(out, candidate)
	}
	addFields := func(fields *ast.FieldList, comparator bool) {
		if fields == nil {
			return
		}
		for _, field := range fields.List {
			for _, id := range field.Names {
				add("parameter", id, field.Type, comparator)
			}
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.FuncLit:
			comparators[node.Type] = isComparatorParams(node.Type.Params)
		case *ast.FuncType:
			addFields(node.Params, comparators[node])
			addFields(node.Results, false)
		case *ast.ValueSpec:
			for _, id := range node.Names {
				add("variable", id, nil, false)
			}
		case *ast.ForStmt:
			if init, ok := node.Init.(*ast.AssignStmt); ok && init.Tok == token.DEFINE {
				for _, lhs := range init.Lhs {
					if id, ok := lhs.(*ast.Ident); ok {
						loopVars[id] = true
					}
				}
			}
		case *ast.AssignStmt:
			if node.Tok == token.DEFINE {
				for _, lhs := range node.Lhs {
					if id, ok := lhs.(*ast.Ident); ok {
						add("variable", id, nil, false)
					}
				}
			}
		case *ast.RangeStmt:
			if node.Tok == token.DEFINE {
				if id, ok := node.Key.(*ast.Ident); ok {
					loopVars[id] = true
				}
				for _, expr := range []ast.Expr{node.Key, node.Value} {
					if id, ok := expr.(*ast.Ident); ok {
						add("variable", id, nil, false)
					}
				}
			}
		}
		return true
	})
	return out
}

func isComparatorParams(params *ast.FieldList) bool {
	var names []string
	for _, field := range params.List {
		for _, id := range field.Names {
			names = append(names, id.Name)
		}
	}
	return len(names) == 2 && names[0] == "a" && names[1] == "b"
}

func runInline(paths []string) []any {
	byDir := map[string][]string{}
	for _, p := range paths {
		dir := filepath.Dir(p)
		byDir[dir] = append(byDir[dir], p)
	}
	dirs := make([]string, 0, len(byDir))
	for dir := range byDir {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)

	fset := token.NewFileSet()
	var results []any
	for _, dir := range dirs {
		dirPaths := byDir[dir]
		sort.Strings(dirPaths)
		files := make([]*ast.File, 0, len(dirPaths))
		ok := make([]string, 0, len(dirPaths))
		for _, p := range dirPaths {
			f, err := parser.ParseFile(fset, p, nil, 0)
			if err != nil {
				fmt.Fprintf(os.Stderr, "go-analyzer: skipping %s: %v\n", p, err)
				continue
			}
			files = append(files, f)
			ok = append(ok, p)
		}
		if len(files) == 0 {
			continue
		}
		results = append(results, analyzePackage(fset, files, ok)...)
	}
	return results
}

type posRange struct{ start, end token.Pos }

func (r posRange) contains(pos token.Pos) bool { return pos >= r.start && pos < r.end }

type parsedFile struct {
	syntax  *ast.File
	path    string
	dir     string
	pkg     string
	isTest  bool
	skip    map[*ast.Ident]bool
	imports map[string]string // local package name -> directory of a scanned package
}

type deadDecl struct {
	kind      string
	file      *parsedFile
	ident     *ast.Ident
	exported  bool
	own       []posRange // where a reference doesn't count: the declaration itself, plus a type's methods
	prodRefs  int
	testRefs  int
	firstTest token.Pos
}

func (d *deadDecl) addRef(pos token.Pos, inTest bool) {
	for _, r := range d.own {
		if r.contains(pos) {
			return
		}
	}
	if !inTest {
		d.prodRefs++
		return
	}
	d.testRefs++
	if !d.firstTest.IsValid() {
		d.firstTest = pos
	}
}

func modulePath(goMod string) string {
	data, err := os.ReadFile(goMod)
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "module"); ok {
			return strings.Trim(strings.TrimSpace(rest), `"`)
		}
	}
	return ""
}

// the import path a directory is reachable under: the nearest go.mod's module path plus the directory below it
func importPathOf(dir string) string {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return ""
	}
	for current := abs; ; current = filepath.Dir(current) {
		if module := modulePath(filepath.Join(current, "go.mod")); module != "" {
			rel, err := filepath.Rel(current, abs)
			if err != nil || rel == "." {
				return module
			}
			return module + "/" + filepath.ToSlash(rel)
		}
		if current == filepath.Dir(current) {
			return ""
		}
	}
}

// receiver base type name, through pointers and type parameters: `*Set[T]` -> `Set`
func receiverTypeName(recv *ast.FieldList) string {
	if recv == nil || len(recv.List) == 0 {
		return ""
	}
	expr := recv.List[0].Type
	for {
		switch e := expr.(type) {
		case *ast.StarExpr:
			expr = e.X
		case *ast.IndexExpr:
			expr = e.X
		case *ast.IndexListExpr:
			expr = e.X
		case *ast.ParenExpr:
			expr = e.X
		case *ast.Ident:
			return e.Name
		default:
			return ""
		}
	}
}

func hasLinkDirective(doc *ast.CommentGroup) bool {
	if doc == nil {
		return false
	}
	for _, c := range doc.List {
		if strings.HasPrefix(c.Text, "//export ") || strings.HasPrefix(c.Text, "//go:linkname") {
			return true
		}
	}
	return false
}

func mentionsIota(decl *ast.GenDecl) bool {
	found := false
	ast.Inspect(decl, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == "iota" {
			found = true
		}
		return !found
	})
	return found
}

func runDeadCode(paths []string) []any {
	sorted := append([]string(nil), paths...)
	sort.Strings(sorted)

	fset := token.NewFileSet()
	var files []*parsedFile
	for _, p := range sorted {
		f, err := parser.ParseFile(fset, p, nil, parser.ParseComments)
		if err != nil {
			fmt.Fprintf(os.Stderr, "go-analyzer: skipping %s: %v\n", p, err)
			continue
		}
		files = append(files, &parsedFile{syntax: f, path: p, dir: filepath.Dir(p), pkg: f.Name.Name, isTest: strings.HasSuffix(p, "_test.go"), skip: declaredIdents(f)})
	}

	dirByImport := map[string]string{}
	pkgNameOfDir := map[string]string{}
	seenDir := map[string]bool{}
	for _, f := range files {
		if !seenDir[f.dir] {
			seenDir[f.dir] = true
			if importPath := importPathOf(f.dir); importPath != "" {
				dirByImport[importPath] = f.dir
			}
		}
		if !strings.HasSuffix(f.pkg, "_test") {
			pkgNameOfDir[f.dir] = f.pkg
		}
	}
	for _, f := range files {
		f.imports = map[string]string{}
		for _, spec := range f.syntax.Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				continue
			}
			dir, ok := dirByImport[importPath]
			if !ok {
				continue
			}
			name := pkgNameOfDir[dir]
			if spec.Name != nil {
				name = spec.Name.Name
			}
			if name != "" && name != "_" && name != "." {
				f.imports[name] = dir
			}
		}
	}

	methodsOf := map[string][]posRange{}
	for _, f := range files {
		for _, decl := range f.syntax.Decls {
			if d, ok := decl.(*ast.FuncDecl); ok && d.Recv != nil {
				key := f.dir + "\x00" + f.pkg + "\x00" + receiverTypeName(d.Recv)
				methodsOf[key] = append(methodsOf[key], posRange{d.Pos(), d.End()})
			}
		}
	}

	var decls []*deadDecl
	byName := map[string][]*deadDecl{}
	add := func(d *deadDecl) {
		decls = append(decls, d)
		byName[d.ident.Name] = append(byName[d.ident.Name], d)
	}
	for _, f := range files {
		if f.isTest {
			continue
		}
		for _, decl := range f.syntax.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				name := d.Name.Name
				if d.Recv != nil || d.Body == nil || name == "init" || name == "_" || (name == "main" && f.pkg == "main") || hasLinkDirective(d.Doc) {
					continue
				}
				add(&deadDecl{kind: "func", file: f, ident: d.Name, exported: exported(name), own: []posRange{{d.Pos(), d.End()}}})
			case *ast.GenDecl:
				// an iota group is an enum: one unused member is normal
				if d.Tok == token.CONST && d.Lparen.IsValid() && mentionsIota(d) {
					continue
				}
				for _, spec := range d.Specs {
					switch s := spec.(type) {
					case *ast.ValueSpec:
						kind := "var"
						if d.Tok == token.CONST {
							kind = "const"
						}
						for _, name := range s.Names {
							if name.Name != "_" {
								add(&deadDecl{kind: kind, file: f, ident: name, exported: exported(name.Name), own: []posRange{{s.Pos(), s.End()}}})
							}
						}
					case *ast.TypeSpec:
						own := append([]posRange{{s.Pos(), s.End()}}, methodsOf[f.dir+"\x00"+f.pkg+"\x00"+s.Name.Name]...)
						add(&deadDecl{kind: "type", file: f, ident: s.Name, exported: exported(s.Name.Name), own: own})
					}
				}
			}
		}
	}

	for _, f := range files {
		qualifiers := map[*ast.Ident]bool{}
		ast.Inspect(f.syntax, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.SelectorExpr:
				qualifier, ok := node.X.(*ast.Ident)
				if !ok {
					break
				}
				dir, imported := f.imports[qualifier.Name]
				if !imported {
					break
				}
				qualifiers[qualifier] = true
				for _, d := range byName[node.Sel.Name] {
					if d.exported && d.file.dir == dir {
						d.addRef(node.Sel.Pos(), f.isTest)
					}
				}
			case *ast.Ident:
				if f.skip[node] || qualifiers[node] {
					break
				}
				for _, d := range byName[node.Name] {
					if d.file.dir == f.dir && d.file.pkg == f.pkg {
						d.addRef(node.Pos(), f.isTest)
					}
				}
			}
			return true
		})
	}

	var out []any
	for _, d := range decls {
		if d.prodRefs > 0 {
			continue
		}
		c := deadCandidate{Kind: d.kind, Name: d.ident.Name, File: d.file.path, Line: fset.Position(d.ident.Pos()).Line, Exported: d.exported, TestRefs: d.testRefs}
		if d.firstTest.IsValid() {
			at := fset.Position(d.firstTest)
			c.TestFile, c.TestLine = at.Filename, at.Line
		}
		out = append(out, c)
	}
	return out
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go-analyzer inline|if-init|multi-assign|single-letter|dead-code < paths.json")
		os.Exit(1)
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-analyzer: reading stdin:", err)
		os.Exit(1)
	}
	var paths []string
	if err := json.Unmarshal(input, &paths); err != nil {
		fmt.Fprintln(os.Stderr, "go-analyzer: parsing stdin as a JSON array of paths:", err)
		os.Exit(1)
	}

	var results []any
	switch os.Args[1] {
	case "inline":
		results = runInline(paths)
	case "if-init":
		results = runPerFile(paths, ifInits)
	case "multi-assign":
		results = runPerFile(paths, multiAssigns)
	case "single-letter":
		results = runPerFile(paths, singleLetters)
	case "dead-code":
		results = runDeadCode(paths)
	default:
		fmt.Fprintln(os.Stderr, "go-analyzer: unknown mode:", os.Args[1])
		os.Exit(1)
	}
	if results == nil {
		results = []any{}
	}

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, "go-analyzer: encoding output:", err)
		os.Exit(1)
	}
}
