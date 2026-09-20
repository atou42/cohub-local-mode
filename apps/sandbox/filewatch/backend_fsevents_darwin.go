//go:build darwin && cgo

package filewatch

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsevents"
)

type fseventsBackend struct {
	stream        *fsevents.EventStream
	eventCh       chan backendEvent
	errorCh       chan error
	done          chan struct{}
	stopped       chan struct{}
	nativeStopped chan struct{}
	once          sync.Once
}

func newFSEventsBackend(root string, _ *slog.Logger) (eventBackend, bool, error) {
	stream := &fsevents.EventStream{
		Paths: []string{filepath.Clean(root)},
		Flags: fsevents.FileEvents | fsevents.WatchRoot,
		// FSEvents already coalesces at the OS boundary. Keep the latency short
		// enough for editor updates; the common watcher applies its own debounce.
		Latency: 250 * time.Millisecond,
		Events:  make(chan []fsevents.Event, 32),
	}
	if err := stream.Start(); err != nil {
		return nil, true, fmt.Errorf("start fsevents: %w", err)
	}
	backend := &fseventsBackend{
		stream:        stream,
		eventCh:       make(chan backendEvent, 256),
		errorCh:       make(chan error, 8),
		done:          make(chan struct{}),
		stopped:       make(chan struct{}),
		nativeStopped: make(chan struct{}),
	}
	go backend.run(root)
	return backend, true, nil
}

func (f *fseventsBackend) events() <-chan backendEvent { return f.eventCh }
func (f *fseventsBackend) errors() <-chan error        { return f.errorCh }
func (f *fseventsBackend) name() string                { return "fsevents" }

func (f *fseventsBackend) close() error {
	f.once.Do(func() {
		close(f.done)
		// run keeps draining the synchronous native callback until Stop returns.
		f.stream.Stop()
		close(f.nativeStopped)
		<-f.stopped
	})
	return nil
}

func (f *fseventsBackend) run(root string) {
	defer close(f.stopped)
	defer close(f.eventCh)
	defer close(f.errorCh)
	defer func() {
		for {
			select {
			case <-f.stream.Events:
			case <-f.nativeStopped:
				return
			}
		}
	}()
	for {
		select {
		case batch, ok := <-f.stream.Events:
			if !ok {
				return
			}
			for _, event := range batch {
				mapped := mapFSEvent(root, event)
				select {
				case f.eventCh <- mapped:
				case <-f.done:
					return
				}
			}
		case <-f.done:
			return
		}
	}
}

func mapFSEvent(root string, event fsevents.Event) backendEvent {
	flags := event.Flags
	if flags&fsevents.RootChanged != 0 {
		return backendEvent{resync: true, failed: true, reason: "root_changed"}
	}
	if flags&(fsevents.MustScanSubDirs|fsevents.KernelDropped|fsevents.UserDropped|fsevents.EventIDsWrapped) != 0 {
		return backendEvent{resync: true}
	}
	path := event.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(string(filepath.Separator), path)
	}
	if flags&fsevents.HistoryDone != 0 {
		return backendEvent{}
	}
	if flags&(fsevents.ItemRenamed|fsevents.Mount|fsevents.Unmount) != 0 {
		return backendEvent{path: filepath.Clean(path), resync: true}
	}
	if filepath.Clean(path) == filepath.Clean(root) {
		return backendEvent{resync: true}
	}

	nodeType := "unknown"
	switch {
	case flags&fsevents.ItemIsDir != 0:
		nodeType = "dir"
	case flags&fsevents.ItemIsFile != 0:
		nodeType = "file"
	case flags&fsevents.ItemIsSymlink != 0:
		nodeType = "unknown"
	}

	if flags&fsevents.ItemRemoved != 0 && flags&fsevents.ItemCreated != 0 {
		return backendEvent{path: filepath.Clean(path), resync: true}
	}
	kind := "modify"
	switch {
	case flags&fsevents.ItemRemoved != 0:
		kind = "delete"
	case flags&fsevents.ItemCreated != 0:
		kind = "create"
	case flags&(fsevents.ItemModified|fsevents.ItemInodeMetaMod|fsevents.ItemFinderInfoMod|fsevents.ItemChangeOwner|fsevents.ItemXattrMod) != 0:
		kind = "modify"
	default:
		return backendEvent{path: filepath.Clean(path), resync: true}
	}
	return backendEvent{path: filepath.Clean(path), kind: kind, nodeType: nodeType}
}
