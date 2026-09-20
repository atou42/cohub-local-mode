package relay

import (
	"errors"
	"net/http"
	"testing"
)

func TestControlRejection(t *testing.T) {
	t.Run("unauthorized is fatal", func(t *testing.T) {
		err := controlRejection(http.StatusUnauthorized, "access token is invalid or expired")
		if !isFatalRelayError(err) {
			t.Fatalf("401 should be fatal, got %T %v", err, err)
		}
		var authErr *relayAuthError
		if !errors.As(err, &authErr) || authErr.status != http.StatusUnauthorized {
			t.Fatalf("401 should be relayAuthError, got %T %v", err, err)
		}
	})

	t.Run("forbidden stays retryable", func(t *testing.T) {
		err := controlRejection(http.StatusForbidden, "missing sandbox.manage permission")
		if isFatalRelayError(err) {
			t.Fatalf("403 should not be fatal, got %v", err)
		}
		var configErr *relayConfigError
		if !errors.As(err, &configErr) || configErr.status != http.StatusForbidden {
			t.Fatalf("403 should be relayConfigError, got %T %v", err, err)
		}
	})

	t.Run("conflict stays retryable", func(t *testing.T) {
		err := controlRejection(http.StatusConflict, "space is not configured for a local sandbox")
		if isFatalRelayError(err) {
			t.Fatalf("409 should not be fatal, got %v", err)
		}
		var configErr *relayConfigError
		if !errors.As(err, &configErr) {
			t.Fatalf("409 should be relayConfigError, got %T %v", err, err)
		}
	})

	t.Run("server error is not a config rejection", func(t *testing.T) {
		err := controlRejection(http.StatusInternalServerError, "authorization failed")
		if isFatalRelayError(err) {
			t.Fatalf("500 should not be fatal, got %v", err)
		}
		var configErr *relayConfigError
		if errors.As(err, &configErr) {
			t.Fatalf("500 should not be relayConfigError, got %v", err)
		}
	})
}

func TestDialStatusClassification(t *testing.T) {
	t.Run("http 401 is fatal", func(t *testing.T) {
		err := &relayAuthError{status: http.StatusUnauthorized, err: errors.New("dial")}
		if !isFatalRelayError(err) {
			t.Fatal("expected HTTP 401 dial to be fatal")
		}
	})

	t.Run("http 403 is retryable", func(t *testing.T) {
		err := &relayConfigError{status: http.StatusForbidden, err: errors.New("dial")}
		if isFatalRelayError(err) {
			t.Fatal("expected HTTP 403 dial not to be fatal")
		}
	})
}
