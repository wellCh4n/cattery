package channel

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// SecretBox seals channel secrets (app secrets, bot tokens) at rest with
// AES-GCM, under a key derived from CHANNEL_SECRET_KEY. Changing that key
// makes every sealed secret unreadable: each channel then needs its secret
// (or a WeChat scan) again.
type SecretBox struct{ aead cipher.AEAD }

const sealedPrefix = "v1:"

func NewSecretBox(key string) (*SecretBox, error) {
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("empty key")
	}
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretBox{aead}, nil
}

func (b *SecretBox) Seal(plain string) string {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return sealedPrefix + base64.StdEncoding.EncodeToString(b.aead.Seal(nonce, nonce, []byte(plain), nil))
}

func (b *SecretBox) Open(sealed string) (string, error) {
	raw, ok := strings.CutPrefix(sealed, sealedPrefix)
	if !ok {
		return "", errors.New("not a sealed secret")
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	n := b.aead.NonceSize()
	if len(data) < n {
		return "", errors.New("sealed secret too short")
	}
	plain, err := b.aead.Open(nil, data[:n], data[n:], nil)
	if err != nil {
		return "", errors.New("cannot open the secret (was CHANNEL_SECRET_KEY changed?)")
	}
	return string(plain), nil
}
