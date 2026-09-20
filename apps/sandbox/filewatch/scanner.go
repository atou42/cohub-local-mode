package filewatch

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	scannerInterval         = 5 * time.Second
	scannerMaxRetryInterval = 5 * time.Minute
	maxScannerEntries       = 250_000
)

type scannerEntry struct {
	nodeType string
	size     int64
	mtimeNs  int64
	mode     os.FileMode
}

type scannerBackend struct {
	root    string
	logger  *slog.Logger
	ignored []string

	eventCh chan backendEvent
	errorCh chan error
	done    chan struct{}
	stopped chan struct{}
	once    sync.Once
}

func newScannerBackend(root string, logger *slog.Logger, ignored []string) (eventBackend, error) {
	backend := &scannerBackend{
		root:    filepath.Clean(root),
		logger:  logger,
		ignored: append([]string(nil), ignored...),
		eventCh: make(chan backendEvent, 256),
		errorCh: make(chan error, 8),
		done:    make(chan struct{}),
		stopped: make(chan struct{}),
	}
	go backend.run()
	return backend, nil
}

func (s *scannerBackend) events() <-chan backendEvent { return s.eventCh }
func (s *scannerBackend) errors() <-chan error        { return s.errorCh }
func (s *scannerBackend) name() string                { return "scan" }

func (s *scannerBackend) close() error {
	s.once.Do(func() {
		close(s.done)
		<-s.stopped
	})
	return nil
}

func (s *scannerBackend) run() {
	defer close(s.stopped)
	defer close(s.eventCh)
	defer close(s.errorCh)

	var previous map[string]scannerEntry
	retryInterval := scannerInterval
	errorReported := false
	for {
		next, err := s.snapshot()
		if err == nil {
			firstSnapshot := previous == nil
			errorReported = false
			retryInterval = scannerInterval
			select {
			case s.eventCh <- backendEvent{healthy: true}:
			case <-s.done:
				return
			}
			events := diffSnapshots(previous, next)
			if firstSnapshot {
				// The first complete snapshot establishes the baseline.
				events = []backendEvent{{resync: true}}
			}
			previous = next
			for _, event := range events {
				if !event.resync {
					event.path = filepath.Join(s.root, filepath.FromSlash(event.path))
				}
				select {
				case s.eventCh <- event:
				case <-s.done:
					return
				}
			}
		} else {
			if !errorReported {
				s.reportError(err)
				errorReported = true
			}
			if retryInterval < scannerMaxRetryInterval {
				retryInterval *= 2
				if retryInterval > scannerMaxRetryInterval {
					retryInterval = scannerMaxRetryInterval
				}
			}
		}

		timer := time.NewTimer(retryInterval)
		select {
		case <-timer.C:
		case <-s.done:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return
		}
	}
}

func (s *scannerBackend) reportError(err error) {
	select {
	case s.errorCh <- err:
	case <-s.done:
	default:
		s.logger.Debug("file metadata scanner error", slog.String("error", err.Error()))
	}
}

func (s *scannerBackend) snapshot() (map[string]scannerEntry, error) {
	entries := make(map[string]scannerEntry)
	info, err := os.Lstat(s.root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workspace root is not a directory")
	}
	// Read directory entries in chunks and close each directory before opening
	// another: both FD use and very wide directory allocations remain bounded.
	dirs := []string{s.root}
	for len(dirs) > 0 {
		dir := dirs[len(dirs)-1]
		dirs = dirs[:len(dirs)-1]
		err := func() error {
			select {
			case <-s.done:
				return context.Canceled
			default:
			}
			info, err := os.Lstat(dir)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return fmt.Errorf("directory changed during scan")
			}
			file, err := os.Open(dir)
			if err != nil {
				return err
			}
			defer file.Close()
			for {
				select {
				case <-s.done:
					return context.Canceled
				default:
				}
				children, readErr := file.ReadDir(256)
				if readErr != nil && readErr != io.EOF {
					return readErr
				}
				for _, child := range children {
					path := filepath.Join(dir, child.Name())
					rel, ok := relativeToRoot(s.root, path)
					if !ok || isIgnoredPath(rel, s.ignored) {
						continue
					}
					if len(entries) >= maxScannerEntries {
						return errScannerLimit
					}
					info, err := child.Info()
					if err != nil {
						return err
					}
					if !isWatchableNode(info.Mode()) {
						continue
					}
					entries[rel] = scannerEntry{nodeType: nodeTypeFor(info), size: info.Size(), mtimeNs: info.ModTime().UnixNano(), mode: info.Mode()}
					if info.IsDir() {
						dirs = append(dirs, path)
					}
				}
				if readErr == io.EOF {
					return nil
				}
			}
		}()
		if err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
	}
	return entries, nil
}

var errScannerLimit = fmt.Errorf("workspace exceeds %d scanner entries", maxScannerEntries)

func relativeToRoot(root, path string) (string, bool) {
	rel, err := filepath.Rel(root, filepath.Clean(path))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	if rel == "." {
		return "", true
	}
	return filepath.ToSlash(rel), true
}

func diffSnapshots(previous, next map[string]scannerEntry) []backendEvent {
	changes := make([]backendEvent, 0)
	for path, oldEntry := range previous {
		if _, ok := next[path]; !ok {
			if len(changes) == maxBatchSize {
				return []backendEvent{{resync: true}}
			}
			changes = append(changes, backendEvent{path: path, kind: "delete", nodeType: oldEntry.nodeType})
		}
	}
	for path, nextEntry := range next {
		oldEntry, ok := previous[path]
		if !ok {
			if len(changes) == maxBatchSize {
				return []backendEvent{{resync: true}}
			}
			changes = append(changes, backendEvent{path: path, kind: "create", nodeType: nextEntry.nodeType})
			continue
		}
		if oldEntry != nextEntry {
			if oldEntry.nodeType != nextEntry.nodeType || len(changes) == maxBatchSize {
				return []backendEvent{{resync: true}}
			}
			changes = append(changes, backendEvent{path: path, kind: "modify", nodeType: nextEntry.nodeType})
		}
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].path < changes[j].path })
	return changes
}
