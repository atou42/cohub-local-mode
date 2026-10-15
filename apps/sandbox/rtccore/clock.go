package rtccore

import (
	"math/rand/v2"
	"time"
)

type Clock struct {
	Rate      uint32
	started   bool
	base      uint32
	basePTS   uint64
	lastPTS   uint64
	lastAt    time.Time
	lastStamp uint32
}

func (c *Clock) Timestamp(pts uint64, now time.Time) uint32 {
	ticks := func(d time.Duration) uint32 {
		return uint32(d/time.Second*time.Duration(c.Rate) + d%time.Second*time.Duration(c.Rate)/time.Second)
	}
	delta := time.Duration(pts-c.lastPTS)*time.Microsecond - now.Sub(c.lastAt)
	switch {
	case !c.started:
		c.started, c.base, c.basePTS = true, rand.Uint32(), pts
	case pts < c.lastPTS || delta > time.Second || delta < -time.Second:
		c.base, c.basePTS = c.lastStamp+ticks(max(0, now.Sub(c.lastAt))), pts
	}
	c.lastPTS, c.lastAt = pts, now
	c.lastStamp = c.base + ticks(time.Duration(pts-c.basePTS)*time.Microsecond)
	return c.lastStamp
}
