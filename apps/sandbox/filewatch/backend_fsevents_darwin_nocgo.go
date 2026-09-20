//go:build darwin && !cgo

package filewatch

import (
	"fmt"
	"log/slog"
)

func newFSEventsBackend(string, *slog.Logger) (eventBackend, bool, error) {
	return nil, true, fmt.Errorf("fsevents requires a cgo-enabled Darwin binary")
}
