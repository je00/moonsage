#!/usr/bin/env python3
"""Private, explicitly scoped client DNS and direct-routing preferences.

This file stores no defaults that change normal DNS egress. Publication performs
an additional check against the live profile's protected infrastructure.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

MAX_RULES = 128
MAX_BYTES = 256 * 1024
DEFAULT_PATH = Path("/etc/server-kit/subscription-rules.json")
RESERVED_RESOLVER_ROUTES = {
    "8.8.8.8": "PROXY", "1.0.0.1": "PROXY", "1.1.1.1": "MID",
    "223.5.5.5": "DIRECT", "1.12.12.12": "DIRECT",
}


class SubscriptionRulesError(ValueError):
    pass


def default_config() -> dict:
    """The explicitly public example is used only before private state exists."""
    return {"version": 1, "direct_rules": [], "dns_rules": [{
        "match": "suffix", "value": "byd.auto", "servers": [
            "https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query",
        ], "route": "DIRECT",
    }]}


def normalize_domain(value: object, match: str) -> str:
    if not isinstance(value, str) or len(value) > 1024:
        raise SubscriptionRulesError("域名格式无效。")
    value = value.strip().rstrip(".")
    if value.startswith(("+.", "*.")):
        if match != "suffix":
            raise SubscriptionRulesError("通配域名请使用“域名及子域名”。")
        value = value[2:]
    try:
        value = value.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise SubscriptionRulesError("域名格式无效。") from None
    labels = value.split(".")
    if len(value) > 253 or len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise SubscriptionRulesError("请填写完整域名，不含协议、端口、路径或全匹配表达式。")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise SubscriptionRulesError("IP 地址请使用 CIDR 直连规则，DNS 规则需填写域名。")


def resolver_address(server: str) -> str:
    return str(ipaddress.ip_address(urlsplit(server).hostname if "://" in server else server))


def normalize_server(value: object, route: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise SubscriptionRulesError("DNS 服务器格式无效。")
    value = value.strip()
    is_doh = "://" in value
    try:
        if is_doh:
            parsed = urlsplit(value)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                    or parsed.password is not None or parsed.query or parsed.fragment
                    or "?" in value or "#" in value or any(char.isspace() for char in value)
                    or not parsed.path or not parsed.path.startswith("/")
                    or parsed.port == 0 or "\\" in value):
                raise ValueError()
            address = ipaddress.ip_address(parsed.hostname)
            host = f"[{address}]" if address.version == 6 else str(address)
            if parsed.port is not None:
                host += f":{parsed.port}"
            value = urlunsplit(("https", host, parsed.path, "", ""))
        else:
            address = ipaddress.ip_address(value)
            value = str(address)
    except ValueError:
        raise SubscriptionRulesError("DNS 仅支持数字 IP 或以数字 IP 为主机的 HTTPS DoH，不支持域名、认证参数和出站片段。") from None
    if (address.is_unspecified or address.is_loopback or address.is_link_local
            or address.is_multicast or getattr(address, "scope_id", None)
            or getattr(address, "ipv4_mapped", None)):
        raise SubscriptionRulesError("DNS 服务器不能使用本机、链路本地、组播或未指定地址。")
    if route in {"PROXY", "MID"} and (not is_doh or not address.is_global):
        raise SubscriptionRulesError("经代理或 VPS 查询的 DNS 必须使用公网数字 IP HTTPS DoH。")
    reserved = RESERVED_RESOLVER_ROUTES.get(str(address))
    if reserved is not None and reserved != route:
        raise SubscriptionRulesError("该 DNS IP 已用于统一出口或启动解析，不能改为其他线路。")
    return value


def normalize_config(value: object) -> dict:
    if not isinstance(value, dict) or set(value) - {"version", "direct_rules", "dns_rules"}:
        raise SubscriptionRulesError("订阅规则必须是受支持的配置对象。")
    if type(value.get("version", 1)) is not int or value.get("version", 1) != 1:
        raise SubscriptionRulesError("订阅规则版本无效。")
    result = {"version": 1, "direct_rules": [], "dns_rules": []}
    resolver_routes: dict[str, str] = {}
    for kind in ("direct_rules", "dns_rules"):
        rules = value.get(kind, [])
        if not isinstance(rules, list) or len(rules) > MAX_RULES:
            raise SubscriptionRulesError("每类规则最多支持 128 条。")
        seen = set()
        for item in rules:
            allowed = {"match", "value"} if kind == "direct_rules" else {"match", "value", "servers", "route"}
            if not isinstance(item, dict) or set(item) != allowed:
                raise SubscriptionRulesError("规则字段不完整或包含不支持的字段。")
            match = item["match"]
            if match not in ("exact", "suffix", "cidr") or (kind == "dns_rules" and match == "cidr"):
                raise SubscriptionRulesError("规则匹配方式无效。")
            if match == "cidr":
                try:
                    if not isinstance(item["value"], str):
                        raise ValueError()
                    network = ipaddress.ip_network(item["value"].strip(), strict=True)
                    if network.prefixlen < (8 if network.version == 4 else 32):
                        raise ValueError()
                    if (getattr(network.network_address, "ipv4_mapped", None)
                            or getattr(network.network_address, "scope_id", None)):
                        raise ValueError()
                    normalized = str(network)
                except ValueError:
                    raise SubscriptionRulesError("请填写 IP 或规范网段 CIDR，IPv4 范围不大于 /8，IPv6 不大于 /32。") from None
            else:
                normalized = normalize_domain(item["value"], match)
            if (match, normalized) in seen:
                raise SubscriptionRulesError("存在重复规则，请合并后重试。")
            seen.add((match, normalized))
            clean = {"match": match, "value": normalized}
            if kind == "dns_rules":
                route = item["route"]
                if route not in ("DIRECT", "PROXY", "MID"):
                    raise SubscriptionRulesError("DNS 路径只能选择代理出口、VPS 或本机直连。")
                servers = item["servers"]
                if not isinstance(servers, list) or not 1 <= len(servers) <= 4:
                    raise SubscriptionRulesError("每条 DNS 规则需要 1 至 4 个服务器。")
                servers = [normalize_server(server, route) for server in servers]
                if len(set(servers)) != len(servers):
                    raise SubscriptionRulesError("DNS 服务器不能重复。")
                for server in servers:
                    address = resolver_address(server)
                    if address in resolver_routes and resolver_routes[address] != route:
                        raise SubscriptionRulesError("同一 DNS IP 不能使用不同查询路径。")
                    resolver_routes[address] = route
                clean.update(servers=servers, route=route)
            result[kind].append(clean)
    if len(_serialized(result)) > MAX_BYTES:
        raise SubscriptionRulesError("规范化后的订阅规则超过 256 KiB，请减少规则或 DNS 地址长度。")
    return result


def _serialized(config: dict) -> bytes:
    # Share the exact budget with normalize/load: pretty printing otherwise
    # allows a valid near-limit request to become an unreadable persisted file.
    return (json.dumps(config, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def load(path: Path) -> dict:
    path = Path(path)
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return default_config()
    except OSError:
        raise SubscriptionRulesError("无法读取私有订阅规则。") from None
    if len(raw) > MAX_BYTES:
        raise SubscriptionRulesError("订阅规则文件过大。")
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {"version", "direct_rules", "dns_rules"}:
            raise SubscriptionRulesError("私有订阅规则缺少必要字段，拒绝使用空配置替代。")
        return normalize_config(value)
    except (ValueError, UnicodeError) as error:
        if isinstance(error, SubscriptionRulesError):
            raise
        raise SubscriptionRulesError("私有订阅规则不是有效 JSON。") from None


def atomic_write(path: Path, config: dict) -> None:
    config = normalize_config(config)
    content = _serialized(config)
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def revision(config: dict) -> str:
    content = json.dumps(normalize_config(config), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def overview(path: Path) -> dict:
    config = load(path)
    return {"schema_version": 1, **config, "revision": revision(config)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("overview", "set"):
        command = commands.add_parser(name)
        command.add_argument("--config", type=Path, default=DEFAULT_PATH)
    args = parser.parse_args()
    try:
        if args.command == "overview":
            response = overview(args.config)
        else:
            raw = sys.stdin.read(MAX_BYTES + 1)
            if len(raw.encode("utf-8")) > MAX_BYTES:
                raise SubscriptionRulesError("订阅规则输入过大。")
            try:
                config = normalize_config(json.loads(raw))
            except json.JSONDecodeError:
                raise SubscriptionRulesError("订阅规则输入不是有效 JSON。") from None
            atomic_write(args.config, config)
            response = {"schema_version": 1, "operation": "set", **config}
        print(json.dumps(response, ensure_ascii=False))
        return 0
    except (SubscriptionRulesError, OSError) as error:
        print(str(error) if isinstance(error, SubscriptionRulesError) else "无法保存私有订阅规则。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
