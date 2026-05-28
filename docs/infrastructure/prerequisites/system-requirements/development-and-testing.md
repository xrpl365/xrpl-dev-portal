# Development and Testing

If you want to try the XRP Ledger, learn how the core server works, or follow tutorials, you don't need production-grade hardware. The other pages in this section describe what's needed to operate reliably in production — for casual development and testing, a much smaller setup is enough.

## Production vs. Development and Testing

The distinction matters because the requirements are very different:

- **Production** is when other people — users, partners, or applications — rely on your server's availability, performance, or correctness. The pages for [Stock Node](stock-node.md), [Validator](validator.md), [Full History](full-history.md), [Hub](hub.md), [Pathing](pathing.md), and [Clio](clio.md) describe production requirements.
- **Development and testing** is when only you or your team rely on the server, usually for learning, prototyping, or experimentation.

The rest of this page covers the second case.

## What's Enough for Learning

The simplest setup is a [stock `rippled` server](../../configuration/server-modes/stock-node.md) on a modest host. The minimum specifications below are typically enough — you don't need to meet the recommended (production) specs documented on the per-type pages.

Hosts that work well:

- A cheap virtual private server (VPS) from a common cloud provider
- A dedicated machine on your home network with reasonable specs
- A spare laptop or desktop

A stock server connects to the network, accepts transactions, and keeps recent ledger history. That's enough for most APIs, tutorials, and exploration. You don't need [full history](../../configuration/server-modes/full-history.md), validator-grade hardware, or a high-end host until you have a production reason.

## Minimum Specifications

{% admonition type="warning" name="Caution" %}These specifications are not enough to reliably [stay synced with Mainnet](../../troubleshooting/server-doesnt-sync.md). For production, see the requirements on the appropriate per-type page.{% /admonition %}

For testing purposes, you can run an XRP Ledger server on commodity hardware with the following minimum requirements:

- Operating System: macOS, Windows (64-bit), or most Linux distributions (Red Hat, Ubuntu, and Debian supported).
- CPU: 64-bit x86_64, 4+ cores.
  - For development purposes, it is also possible to compile `rippled` for some Apple Silicon or ARM processors. See the [Build instructions](https://github.com/XRPLF/rippled/blob/develop/BUILD.md) for guidance. However, architectures other than x86_64 are not officially supported and are not recommended for production.
- Disk: SSD / NVMe (10,000 IOPS sustained - not burst or peak - or better). Minimum 50 GB for the database partition. Do not use Amazon Elastic Block Store (AWS EBS) because its latency is too high to sync reliably.
- RAM: 16 GB+.

<!-- SPELLING_IGNORE: iops, ntp, x86_64, ec2, nvme -->

Amazon EC2's `i3.2xlarge` VM size may be appropriate depending on your workload. A fast network connection is preferable. Any increase in a server's client-handling load increases resources needs.

## See Also

- [System Requirements](index.md) — overview of requirements across server types
- [Install `rippled`](../../installation/index.md) — installation steps for supported platforms
