package api

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func TestNormalizeName(t *testing.T) {
	for _, tc := range []struct {
		input, want string
		invalid     bool
	}{
		{"  小陈  ", "小陈", false}, {" \t\n ", "", false},
		{strings.Repeat("陈", 64), strings.Repeat("陈", 64), false},
		{strings.Repeat("陈", 65), "", true}, {"a\nb", "", true}, {"a\x00b", "", true},
	} {
		got, err := normalizeName(tc.input)
		if (err != nil) != tc.invalid || got != tc.want {
			t.Fatalf("normalizeName(%q) = %q, %v", tc.input, got, err)
		}
	}
}

func TestNormalizeAvatar(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 600, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 600; x++ {
			c := color.RGBA{255, 0, 0, 255}
			if x >= 200 && x < 400 {
				c = color.RGBA{0, 255, 0, 255}
			}
			src.Set(x, y, c)
		}
	}
	for _, format := range []string{"png", "jpeg"} {
		var input bytes.Buffer
		if format == "png" {
			_ = png.Encode(&input, src)
		} else {
			_ = jpeg.Encode(&input, src, nil)
		}
		data, err := normalizeAvatar(input.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		out, err := png.Decode(bytes.NewReader(data))
		if err != nil || out.Bounds().Dx() != 256 || out.Bounds().Dy() != 256 {
			t.Fatalf("invalid output: %v", err)
		}
		r, g, _, _ := out.At(128, 128).RGBA()
		if g < 60000 || r > 1000 {
			t.Fatal("avatar should crop the center square")
		}
		if len(data) > 524288 {
			t.Fatal("normalized avatar exceeds database limit")
		}
	}
}

func TestRejectInvalidAvatar(t *testing.T) {
	var seed bytes.Buffer
	_ = png.Encode(&seed, image.NewRGBA(image.Rect(0, 0, 1, 1)))
	huge := seed.Bytes()
	binary.BigEndian.PutUint32(huge[16:20], 20000)
	binary.BigEndian.PutUint32(huge[20:24], 20000)
	binary.BigEndian.PutUint32(huge[29:33], crc32.ChecksumIEEE(huge[12:29]))
	for _, data := range [][]byte{[]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), []byte("not an image"), make([]byte, maxAvatarBytes+1), huge} {
		if _, err := normalizeAvatar(data); err == nil {
			t.Fatal("accepted an invalid or oversized avatar")
		}
	}
}
