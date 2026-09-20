package rpc

import "testing"

func TestValidateSearchLiterals(t *testing.T) {
	if err := validateSearchLiterals([]string{"needle"}); err != nil {
		t.Fatalf("valid literal rejected: %v", err)
	}
	for _, literals := range [][]string{
		nil,
		{"a"},
		{"ab"},
		{"  "},
	} {
		if err := validateSearchLiterals(literals); err == nil {
			t.Fatalf("invalid literals accepted: %#v", literals)
		}
	}
}
