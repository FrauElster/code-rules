// go-analyzer is spawned as a subprocess by lib/go-analyzer.js. It reads a JSON array of absolute
// .go file paths on stdin, groups them by directory (Go's package boundary), and emits JSON
// candidates for the `inline` check's two hard, non-tunable rules:
//
//   - a top-level func used from exactly one place in its package
//   - a top-level const whose every use sits inside the same single enclosing function
//
// Tunable filtering (--max-lines, --include-exported) stays in inline.js, same as the ts-morph path.
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
	"io"
	"os"
	"path/filepath"
	"sort"
	"unicode"
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

func main() {
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
	if results == nil {
		results = []any{}
	}

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, "go-analyzer: encoding output:", err)
		os.Exit(1)
	}
}
