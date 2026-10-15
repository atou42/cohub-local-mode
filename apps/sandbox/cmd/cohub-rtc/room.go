package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/cohub/apps/sandbox/rtccore"
	"github.com/pion/webrtc/v4"
	"golang.org/x/time/rate"
)

type publication struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Delivery string `json:"delivery"`
}
type member struct {
	ParticipantID string        `json:"participantId"`
	Publications  []publication `json:"publications"`
}
type subscription struct {
	ParticipantID string  `json:"participantId"`
	PublicationID string  `json:"publicationId"`
	ChannelID     *uint16 `json:"channelId,omitempty"`
	Mid           string  `json:"mid,omitempty"`
	name          string
	kind          string
	channel       *webrtc.DataChannel
}
type opened struct {
	SessionID  string                    `json:"sessionId"`
	Offer      webrtc.SessionDescription `json:"offer"`
	ICEServers []webrtc.ICEServer        `json:"iceServers"`
}
type exchange struct {
	Offer         *webrtc.SessionDescription `json:"offer"`
	Answer        *webrtc.SessionDescription `json:"answer"`
	Publications  []publication              `json:"publications"`
	ChannelIDs    map[string]uint16          `json:"channelIds"`
	Subscriptions []subscription             `json:"subscriptions"`
}
type room struct {
	bridge  *bridge
	config  configuration
	members []member
}

type session struct {
	room      *room
	id        string
	pc        *webrtc.PeerConnection
	ctx       context.Context
	cancel    context.CancelFunc
	tasks     sync.WaitGroup
	failed    chan error
	connected chan struct{}
	mu        sync.Mutex
	remote    map[string]*subscription
	local     []*source
	channel   *webrtc.DataChannel
	limiter   *rate.Limiter
}

var errConnectionFailed = errors.New("RTC connection failed")
var errSubscriptionsChanged = errors.New("RTC publications changed during subscription")

func (r *room) run(ctx context.Context) error {
	attempt := 0
	for ctx.Err() == nil {
		s, err := r.connect(ctx)
		if err == nil {
			attempt = 0
			err = s.serve()
		}
		if s != nil {
			s.close()
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var remote *signalError
		if errors.As(err, &remote) && (remote.code == "RTC_FORBIDDEN" || remote.code == "ROOM_EXPIRED" || remote.code == "ROOM_NOT_FOUND" || remote.code == "RTC_UNAVAILABLE") {
			return err
		}
		if !errors.Is(err, errConnectionFailed) && (!errors.As(err, &remote) || remote.code != "RTC_STALE" && remote.code != "RTC_SESSION_NOT_FOUND" && remote.code != "RTC_RATE_LIMITED") {
			return err
		}
		if r.config.Audio != "" || r.config.Video != "" || r.config.DataInput != "" {
			return err
		}
		r.bridge.emit(map[string]any{"kind": "rtc", "state": "reconnecting", "error": err.Error()})
		delay := min(time.Duration(1<<min(attempt, 5))*500*time.Millisecond, 15*time.Second)
		attempt++
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return ctx.Err()
}

func (r *room) connect(ctx context.Context) (*session, error) {
	var opened opened
	if err := r.bridge.request(ctx, "POST", "", map[string]any{}, &opened); err != nil {
		return nil, err
	}
	child, cancel := context.WithCancel(ctx)
	s := &session{room: r, id: opened.SessionID, ctx: child, cancel: cancel, failed: make(chan error, 1), connected: make(chan struct{}, 1), remote: make(map[string]*subscription)}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(webrtc.SettingEngine{LoggerFactory: rtccore.Loggers{Logger: slog.Default()}}))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: opened.ICEServers, BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		return s, err
	}
	s.pc = pc
	s.limiter = rate.NewLimiter(8, 1)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case s.connected <- struct{}{}:
			default:
			}
		}
		if state == webrtc.PeerConnectionStateFailed {
			s.fail(errConnectionFailed)
		}
	})
	pc.OnTrack(s.receive)
	if err = s.answer(opened.Offer); err != nil {
		return s, err
	}
	select {
	case <-s.connected:
	case err = <-s.failed:
		return s, err
	case <-ctx.Done():
		return s, ctx.Err()
	case <-time.After(15 * time.Second):
		return s, errors.New("RTC connection timed out")
	}
	if err = s.publish(); err != nil {
		return s, err
	}
	r.bridge.emit(map[string]any{"kind": "rtc", "state": "connected"})
	return s, nil
}

func (s *session) fail(err error) {
	select {
	case s.failed <- err:
	default:
	}
	s.cancel()
}
func (s *session) request(method, path string, body, result any) error {
	if err := s.limiter.Wait(s.ctx); err != nil {
		return err
	}
	return s.room.bridge.request(s.ctx, method, "/"+s.id+path, body, result)
}
func (s *session) answer(offer webrtc.SessionDescription) error {
	if err := s.pc.SetRemoteDescription(offer); err != nil {
		return err
	}
	answer, err := rtccore.LocalDescription(s.ctx, s.pc, false)
	if err != nil {
		return err
	}
	return s.request("PUT", "", map[string]any{"answer": answer}, nil)
}
func (s *session) close() {
	s.cancel()
	if s.channel != nil && s.room.config.Delivery == "reliable" {
		deadline := time.Now().Add(2 * time.Second)
		for s.channel.BufferedAmount() > 0 && s.channel.ReadyState() == webrtc.DataChannelStateOpen && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if s.channel.BufferedAmount() > 0 {
			s.room.bridge.fail(errors.New("RTC closed with pending reliable data"))
		}
	}
	if s.pc != nil {
		_ = s.pc.Close()
	}
	s.tasks.Wait()
	_ = s.room.bridge.emit(map[string]any{"kind": "release", "sessionId": s.id})
}

func (s *session) publish() error {
	config := s.room.config
	if config.Channel != "" {
		var result exchange
		if err := s.request("POST", "/publish", map[string]any{"channels": []any{map[string]any{"name": config.Channel, "delivery": config.Delivery}}}, &result); err != nil {
			return err
		}
		if len(result.Publications) != 1 {
			return errors.New("RTC did not publish the data channel")
		}
		id, ok := result.ChannelIDs[result.Publications[0].ID]
		if !ok {
			return errors.New("RTC did not return a data channel id")
		}
		channel, err := s.dataChannel(config.Channel, id)
		if err != nil {
			return err
		}
		s.channel = channel
	}
	for _, kind := range []string{"audio", "video"} {
		path := config.Audio
		if kind == "video" {
			path = config.Video
		}
		if path == "" {
			continue
		}
		src, err := newSource(s.ctx, config, kind, path)
		if err != nil {
			return err
		}
		s.local = append(s.local, src)
		transceiver, err := s.pc.AddTransceiverFromTrack(src.track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			return err
		}
		src.transceiver = transceiver
		s.tasks.Go(func() {
			buffer := make([]byte, 1500)
			for {
				if _, _, err := transceiver.Sender().Read(buffer); err != nil {
					return
				}
			}
		})
	}
	if len(s.local) > 0 {
		offer, err := rtccore.LocalDescription(s.ctx, s.pc, true)
		if err != nil {
			return err
		}
		tracks := make([]any, 0, len(s.local))
		for _, src := range s.local {
			tracks = append(tracks, map[string]any{"name": src.kind, "kind": src.kind, "mid": src.transceiver.Mid()})
		}
		var result exchange
		if err = s.request("POST", "/publish", map[string]any{"offer": offer, "tracks": tracks}, &result); err != nil {
			return err
		}
		for _, publication := range result.Publications {
			for _, src := range s.local {
				if src.kind == publication.Name {
					src.publicationID = publication.ID
				}
			}
		}
		for _, src := range s.local {
			if src.publicationID == "" {
				return errors.New("RTC did not publish a media track")
			}
		}
		if result.Answer == nil {
			return errors.New("RTC did not answer the media offer")
		}
		if err = s.pc.SetRemoteDescription(*result.Answer); err != nil {
			return err
		}
	}
	return nil
}

func (s *session) serve() error {
	finished := make(chan *source, len(s.local))
	for _, src := range s.local {
		s.tasks.Go(func() {
			if err := src.run(); err != nil && s.ctx.Err() == nil {
				s.fail(err)
			} else if s.ctx.Err() == nil {
				finished <- src
			}
		})
	}
	if s.room.config.DataInput != "" {
		s.tasks.Go(func() {
			if err := s.sendData(); err != nil && s.ctx.Err() == nil {
				s.fail(err)
			}
		})
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		var refresh <-chan time.Time
		if err := s.reconcile(); errors.Is(err, errSubscriptionsChanged) {
			refresh = time.After(time.Second)
		} else if err != nil {
			return err
		}
		select {
		case err := <-s.failed:
			return err
		case <-s.ctx.Done():
			select {
			case err := <-s.failed:
				return err
			default:
				return s.ctx.Err()
			}
		case src := <-finished:
			if src.publicationID != "" {
				if err := src.transceiver.Stop(); err != nil {
					return err
				}
				offer, err := rtccore.LocalDescription(s.ctx, s.pc, true)
				if err != nil {
					return err
				}
				var result exchange
				if err = s.request("POST", "/unpublish", map[string]any{"ids": []string{src.publicationID}, "offer": offer}, &result); err != nil {
					return err
				}
				if result.Answer == nil {
					return errors.New("RTC did not answer the unpublish offer")
				}
				if err = s.pc.SetRemoteDescription(*result.Answer); err != nil {
					return err
				}
			}
		case members := <-s.room.bridge.members:
			s.room.members = members
		case <-refresh:
			if err := s.request("GET", "", nil, nil); err != nil {
				return err
			}
		case <-ticker.C:
			if err := s.request("GET", "", nil, nil); err != nil {
				return err
			}
		}
	}
}

func (s *session) dataChannel(name string, id uint16) (*webrtc.DataChannel, error) {
	negotiated, ordered := true, s.room.config.Delivery != "latest"
	options := &webrtc.DataChannelInit{Negotiated: &negotiated, ID: &id, Ordered: &ordered}
	if !ordered {
		retransmits := uint16(0)
		options.MaxRetransmits = &retransmits
	}
	return s.pc.CreateDataChannel(name, options)
}

func (s *session) reconcile() error {
	wanted := make(map[string]*subscription)
	mediaCount := 0
	for _, member := range s.room.members {
		if member.ParticipantID == s.room.config.ParticipantID {
			continue
		}
		for _, pub := range member.Publications {
			if pub.Kind == "data" {
				delivery := pub.Delivery
				if delivery == "" {
					delivery = "reliable"
				}
				if pub.Name != s.room.config.Channel || delivery != s.room.config.Delivery {
					continue
				}
			} else {
				if s.room.config.Output == "" || (s.room.config.Participant != "" && member.ParticipantID != s.room.config.Participant) || mediaCount >= 16 {
					continue
				}
				mediaCount++
			}
			key := member.ParticipantID + ":" + pub.ID
			wanted[key] = &subscription{ParticipantID: member.ParticipantID, PublicationID: pub.ID, name: pub.Name, kind: pub.Kind}
		}
	}
	s.mu.Lock()
	stale := make([]*subscription, 0)
	for key, item := range s.remote {
		if wanted[key] == nil {
			stale = append(stale, item)
		}
	}
	s.mu.Unlock()
	for len(stale) > 0 {
		count := min(64, len(stale))
		batch := stale[:count]
		stale = stale[count:]
		body := map[string]any{"items": batch}
		media := false
		for _, item := range batch {
			if item.Mid == "" {
				continue
			}
			media = true
			for _, transceiver := range s.pc.GetTransceivers() {
				if transceiver.Mid() == item.Mid {
					if err := transceiver.Stop(); err != nil {
						return err
					}
				}
			}
		}
		if media {
			offer, err := rtccore.LocalDescription(s.ctx, s.pc, true)
			if err != nil {
				return err
			}
			body["offer"] = offer
		}
		var result exchange
		if err := s.request("POST", "/unsubscribe", body, &result); err != nil {
			return err
		}
		if result.Answer != nil {
			if err := s.pc.SetRemoteDescription(*result.Answer); err != nil {
				return err
			}
		} else if media {
			return errors.New("RTC did not answer the unsubscribe offer")
		}
		for _, item := range batch {
			if item.channel != nil {
				_ = item.channel.Close()
			}
			s.mu.Lock()
			delete(s.remote, item.ParticipantID+":"+item.PublicationID)
			s.mu.Unlock()
		}
	}
	for _, kind := range []string{"data", "media"} {
		missing := make([]*subscription, 0)
		s.mu.Lock()
		for key, item := range wanted {
			if s.remote[key] == nil && ((kind == "data") == (item.kind == "data")) {
				missing = append(missing, item)
			}
		}
		s.mu.Unlock()
		for len(missing) > 0 {
			count := min(64, len(missing))
			batch := missing[:count]
			missing = missing[count:]
			var result exchange
			if err := s.request("POST", "/subscribe", map[string]any{"kind": kind, "items": batch}, &result); err != nil {
				return err
			}
			for _, item := range result.Subscriptions {
				key := item.ParticipantID + ":" + item.PublicationID
				target := wanted[key]
				if target == nil {
					return errors.New("RTC returned an unexpected subscription")
				}
				target.Mid = item.Mid
				if kind == "data" {
					if item.ChannelID == nil {
						return errors.New("RTC subscription has no data channel id")
					}
					channel, err := s.dataChannel(target.name, *item.ChannelID)
					if err != nil {
						return err
					}
					target.channel = channel
					var last uint32
					var received bool
					channel.OnMessage(func(message webrtc.DataChannelMessage) {
						if len(message.Data) < 5 || len(message.Data) > 65541 {
							return
						}
						sequence := binary.BigEndian.Uint32(message.Data[1:5])
						if s.room.config.Delivery == "latest" && received && (sequence == last || sequence-last >= 0x80000000) {
							return
						}
						last, received = sequence, true
						var data any
						if message.Data[0]&1 != 0 {
							data = map[string]any{"base64": message.Data[5:]}
						} else if json.Unmarshal(message.Data[5:], &data) != nil {
							return
						}
						s.room.bridge.emit(map[string]any{"kind": "data", "from": target.ParticipantID, "data": data})
					})
				}
				s.mu.Lock()
				s.remote[key] = target
				s.mu.Unlock()
			}
			if result.Offer != nil {
				if err := s.answer(*result.Offer); err != nil {
					return err
				}
			}
			if len(result.Subscriptions) != len(batch) {
				return errSubscriptionsChanged
			}
		}
	}
	return nil
}
