//go:build unix

package filewatch

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func mkfifo(t *testing.T, path string) {
	t.Helper()
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}
}

func TestScannerSkipsSpecialFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := (&scannerBackend{root: root, ignored: IgnorePatterns(), done: make(chan struct{})}).snapshot()
	if err != nil {
		t.Fatal(err)
	}

	mkfifo(t, filepath.Join(root, "pipe"))
	after, err := (&scannerBackend{root: root, ignored: IgnorePatterns(), done: make(chan struct{})}).snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := after["pipe"]; ok {
		t.Fatal("special file entered the scanner baseline")
	}
	if changes := diffSnapshots(before, after); len(changes) != 0 {
		t.Fatalf("special file produced changes: %v", changes)
	}
}

func TestBackendEventSkipsSpecialFiles(t *testing.T) {
	root := t.TempDir()
	pipe := filepath.Join(root, "pipe")
	mkfifo(t, pipe)

	w := &Watcher{root: root, ignored: IgnorePatterns(), pending: make(map[string]Change), closed: make(chan struct{})}
	defer w.Close()
	w.handleBackendEvent(backendEvent{path: pipe, kind: "create"})
	if len(w.pending) != 0 {
		t.Fatalf("special file produced a change: %v", w.pending)
	}
}
