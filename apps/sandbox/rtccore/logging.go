package rtccore

import (
	"fmt"
	"log/slog"

	"github.com/pion/logging"
)

type Loggers struct{ Logger *slog.Logger }

func (f Loggers) NewLogger(scope string) logging.LeveledLogger {
	return logger{f.Logger.With(slog.String("pion", scope))}
}

type logger struct{ log *slog.Logger }

func (l logger) Trace(string)                      {}
func (l logger) Tracef(string, ...any)             {}
func (l logger) Debug(string)                      {}
func (l logger) Debugf(string, ...any)             {}
func (l logger) Info(string)                       {}
func (l logger) Infof(string, ...any)              {}
func (l logger) Warn(message string)               { l.log.Debug(message) }
func (l logger) Warnf(format string, args ...any)  { l.log.Debug(fmt.Sprintf(format, args...)) }
func (l logger) Error(message string)              { l.log.Warn(message) }
func (l logger) Errorf(format string, args ...any) { l.log.Warn(fmt.Sprintf(format, args...)) }
