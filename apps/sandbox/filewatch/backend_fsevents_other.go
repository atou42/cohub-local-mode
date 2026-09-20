//go:build !darwin

package filewatch

import "log/slog"

func newFSEventsBackend(string, *slog.Logger) (eventBackend, bool, error) {
	return nil, false, nil
}
