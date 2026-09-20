package filewatch

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func testWatcher(t *testing.T) *Watcher {
	t.Helper()
	w := &Watcher{root: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), pending: make(map[string]Change), closed: make(chan struct{}), handler: func(Batch) {}}
	t.Cleanup(func() { _ = w.Close() })
	return w
}

func TestRootInvalidationDoesNotEmitEmptyPath(t *testing.T) {
	for _, op := range []fsnotify.Op{fsnotify.Remove, fsnotify.Rename} {
		w := testWatcher(t)
		w.handleEvent(fsnotify.Event{Name: w.root, Op: op})
		if !w.resync || len(w.pending) != 0 || w.Status().Reason != "root_changed" {
			t.Fatalf("root event: %+v", w.Status())
		}
		w.handleEvent(fsnotify.Event{Name: filepath.Join(w.root, "child"), Op: fsnotify.Write})
		if w.Status().Reason != "root_changed" {
			t.Fatal("child event must not prove root recovery")
		}
	}
}

func TestTransientHealthRecovery(t *testing.T) {
	w := testWatcher(t)
	w.markFailure("watch_error")
	if w.Status().State != "degraded" {
		t.Fatal(w.Status())
	}
	w.handleBackendEvent(backendEvent{healthy: true})
	if w.Status().State != "running" {
		t.Fatal(w.Status())
	}
	w.markUnavailable("watch_error")
	w.handleBackendEvent(backendEvent{healthy: true})
	if w.Status().State != "unavailable" {
		t.Fatal("a stopped backend must not recover from a queued event")
	}
}

func TestRootReplacementDoesNotRecoverFromPathOnlyRepair(t *testing.T) {
	w := testWatcher(t)
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	w.watcher = fw
	w.markFailure("root_changed")
	if err := os.RemoveAll(w.root); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(w.root, 0o700); err != nil {
		t.Fatal(err)
	}
	w.addRecursiveBestEffort(w.root)
	if w.Status().Reason != "root_changed" {
		t.Fatalf("root replacement recovered incorrectly: %+v", w.Status())
	}
}

func TestFullCoverageRepairRestoresHealth(t *testing.T) {
	w := testWatcher(t)
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	w.watcher = fw
	w.markFailure("coverage_incomplete")
	w.addRecursiveBestEffort(w.root)
	if w.Status().State != "running" {
		t.Fatal(w.Status())
	}
}

func TestUnexpectedChannelCloseMarksUnavailable(t *testing.T) {
	w := testWatcher(t)
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	w.watcher = fw
	if err := fw.Close(); err != nil {
		t.Fatal(err)
	}
	w.loop()
	if w.Status().State != "unavailable" || !w.resync {
		t.Fatal(w.Status())
	}
}

func TestScannerFailureThenRecoveryPreservesOrdering(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	backend, err := newScannerBackend(root, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.close()
	select {
	case err := <-backend.errors():
		if err == nil {
			t.Fatal("expected failure")
		}
	case <-time.After(time.Second):
		t.Fatal("missing initial failure")
	}
	select {
	case err := <-backend.errors():
		t.Fatalf("failure emitted repeated work: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(12 * time.Second)
	healthy := false
	for {
		select {
		case event := <-backend.events():
			if event.healthy {
				healthy = true
			}
			if event.resync {
				if !healthy {
					t.Fatal("resync preceded recovery")
				}
				return
			}
		case <-deadline:
			t.Fatal("scanner failed to recover after backoff")
		}
	}
}
