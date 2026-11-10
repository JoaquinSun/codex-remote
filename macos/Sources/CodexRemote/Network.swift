import Darwin
import Foundation

enum Network {
    struct Interface: Identifiable, Hashable {
        enum Kind: Int, Comparable {
            case lan = 0
            case tailscale = 1
            case other = 2

            static func < (lhs: Kind, rhs: Kind) -> Bool { lhs.rawValue < rhs.rawValue }
        }

        let id: String
        let name: String
        let address: String
        let kind: Kind

        var kindTitle: String {
            switch kind {
            case .lan: return "局域网"
            case .tailscale: return "Tailscale"
            case .other: return "网络"
            }
        }
    }

    /// Every reachable IPv4 address, ordered LAN first, then Tailscale, then the
    /// remaining private/usable interfaces. Loopback and link-local addresses
    /// are skipped because phones cannot use them for this server.
    static func ipv4Interfaces() -> [Interface] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, head != nil else { return [] }
        defer { freeifaddrs(head) }

        var seen = Set<String>()
        var interfaces: [Interface] = []
        var pointer = head
        while let current = pointer {
            let entry = current.pointee
            let flags = Int32(entry.ifa_flags)
            let up = (flags & IFF_UP) != 0
            let loopback = (flags & IFF_LOOPBACK) != 0

            if up && !loopback, let rawAddress = entry.ifa_addr, rawAddress.pointee.sa_family == UInt8(AF_INET) {
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let length = socklen_t(rawAddress.pointee.sa_len)
                let result = getnameinfo(
                    rawAddress,
                    length,
                    &buffer,
                    socklen_t(buffer.count),
                    nil,
                    0,
                    NI_NUMERICHOST
                )
                if result == 0 {
                    let ip = String(cString: buffer)
                    let name = entry.ifa_name.map { String(cString: $0) } ?? "en0"
                    if !ip.isEmpty, !ip.hasPrefix("169.254."), seen.insert(ip).inserted {
                        interfaces.append(Interface(
                            id: "\(name)-\(ip)",
                            name: name,
                            address: ip,
                            kind: classify(ip)
                        ))
                    }
                }
            }
            pointer = entry.ifa_next
        }

        return interfaces.sorted { lhs, rhs in
            if lhs.kind != rhs.kind { return lhs.kind < rhs.kind }
            return lhs.address.localizedStandardCompare(rhs.address) == .orderedAscending
        }
    }

    static func classify(_ address: String) -> Interface.Kind {
        let octets = address.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return .other }
        if octets[0] == 100, (64...127).contains(octets[1]) {
            return .tailscale
        }
        if octets[0] == 10 { return .lan }
        if octets[0] == 192, octets[1] == 168 { return .lan }
        if octets[0] == 172, (16...31).contains(octets[1]) { return .lan }
        return .other
    }
}
