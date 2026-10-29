// Package lark is the Lark channel plugin: a self-built Lark app's bot
// (open.larksuite.com). Lark is Feishu's international edition, a separate
// platform with its own apps and accounts; both are built on package larksuite.
package lark

import (
	sdk "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/wellch4n/cattery/internal/channel/larksuite"
)

// New is the Lark plugin.
func New() *larksuite.Plugin { return larksuite.New(sdk.LarkBaseUrl) }
