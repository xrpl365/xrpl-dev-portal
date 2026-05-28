---
seo:
    description: Shared system requirements for rippled and Clio across all server types.
labels:
  - Core Server
---
# System Requirements

Specific hardware and software requirements vary by server type. For production deployments, see the per-type pages: [Stock Node](stock-node.md), [Validator](validator.md), [Full History](full-history.md), [Hub](hub.md), [Pathing](pathing.md), and [Clio](clio.md). For development or test use, see [Development and Testing](development-and-testing.md). The requirements on this page apply across all of them.


## System Time

A `rippled` server relies on maintaining the correct time. It is recommended that the system synchronize time using the Network Time Protocol (NTP) with daemons such as `ntpd` or `chrony`.


## See Also

- **Concepts:**
    - [The `rippled` Server](../../../concepts/networks-and-servers/index.md)
    - [Consensus](../../../concepts/consensus-protocol/index.md)
- **Tutorials:**
    - [Capacity Planning](../capacity-planning.md)
    - [Install `rippled`](../../installation/index.md)
    - [Troubleshoot rippled](../../troubleshooting/index.md)
- **References:**
    - [rippled API Reference](../../../references/http-websocket-apis/index.md)
        - [`rippled` Commandline Usage](../../commandline-usage.md)
        - [server_info method][]

{% raw-partial file="/docs/_snippets/common-links.md" /%}
