module github.com/ZiChuanLan/meta-gateway-plugins/plugins/jev-router

// Tracked against the gateway's Go minor on purpose: this plugin speaks the
// sidecar protocol meta-gateway defines, and matching toolchains keep gofmt and
// go vet behaving identically in both repositories.
go 1.26
