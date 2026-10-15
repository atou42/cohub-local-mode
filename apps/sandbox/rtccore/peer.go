package rtccore

import (
	"context"
	"time"

	"github.com/pion/webrtc/v4"
)

func LocalDescription(ctx context.Context, pc *webrtc.PeerConnection, offer bool) (*webrtc.SessionDescription, error) {
	gathered := webrtc.GatheringCompletePromise(pc)
	var description webrtc.SessionDescription
	var err error
	if offer {
		description, err = pc.CreateOffer(nil)
	} else {
		description, err = pc.CreateAnswer(nil)
	}
	if err != nil {
		return nil, err
	}
	if err = pc.SetLocalDescription(description); err != nil {
		return nil, err
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-gathered:
	case <-timer.C:
	}
	return pc.LocalDescription(), nil
}
