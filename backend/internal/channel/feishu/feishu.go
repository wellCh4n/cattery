// Package feishu is the Feishu channel plugin: a self-built Feishu app's bot
// (open.feishu.cn). Lark, Feishu's international edition, is a separate
// platform with its own package; both are built on package larksuite.
package feishu

import (
	sdk "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/wellch4n/cattery/internal/channel/larksuite"
)

// New is the Feishu plugin.
func New() *larksuite.Plugin { return larksuite.New(sdk.FeishuBaseUrl) }
