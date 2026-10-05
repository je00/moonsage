#!/usr/bin/env python3
"""Minimal, local-only Xray user traffic statistics configuration.

Only StatsService is enabled, through a mode-0600 Unix socket. Rendering never
starts a process, queries an API, changes identities, or modifies network-port
access. A dedicated local inbound tag is the only route to the API.
"""

from __future__ import annotations

import copy
import posixpath
import re


STATS_SOCKET_PATH = "/run/xray/server-kit-stats.sock"
STATS_ADDRESS = f"unix:{STATS_SOCKET_PATH}"
STATS_API_TAG = "server-kit-stats-api"
STATS_INBOUND_TAG = "server-kit-stats-in"
STATS_API = {"tag": STATS_API_TAG, "services": ["StatsService"]}
# 'unix' is required by Xray's dokodemo Network() to create a Unix worker.
# The settings port is a dummy destination, NOT a listening network port.
STATS_INBOUND = {
    "tag": STATS_INBOUND_TAG, "listen": f"{STATS_SOCKET_PATH},0600",
    "protocol": "dokodemo-door",
    "settings": {"address": "127.0.0.1", "port": 1, "network": "unix"},
}
STATS_RULE = {"type": "field", "inboundTag": [STATS_INBOUND_TAG], "outboundTag": STATS_API_TAG}
MANAGED_EMAIL = re.compile(
    r"(?:server-kit-vless:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
    r"|server-kit-relay-vless:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:[a-f0-9]{12})\Z"
)


class XrayStatsError(ValueError):
    """A conflicting configuration cannot be safely instrumented."""


def _object(value: object, field: str) -> dict:
    if not isinstance(value, dict):
        raise XrayStatsError(f"Xray {field} 必须是对象，无法安全启用流量统计。")
    return value


def render_xray_stats(config: dict) -> dict:
    """Idempotently enable local stats, rejecting API/tag/socket conflicts."""
    result = copy.deepcopy(_object(config, "配置"))
    if "api" in result and result["api"] != STATS_API:
        raise XrayStatsError("Xray 已有其他 API 配置；请先处理冲突，统计接口仅允许本机 StatsService。")
    inbounds, outbounds = result.setdefault("inbounds", []), result.setdefault("outbounds", [])
    routing = _object(result.setdefault("routing", {}), "routing")
    rules = routing.setdefault("rules", [])
    if not all(isinstance(items, list) for items in (inbounds, outbounds, rules)):
        raise XrayStatsError("Xray 入站、出站或路由列表格式无效。")
    levels_to_enable = {0}
    matching_inbounds = 0
    for inbound in inbounds:
        _object(inbound, "入站")
        listen = inbound.get("listen", "")
        socket_conflict = isinstance(listen, str) and posixpath.normpath(listen.split(",", 1)[0]) == STATS_SOCKET_PATH
        if inbound.get("tag") in {STATS_API_TAG, STATS_INBOUND_TAG} or socket_conflict:
            if inbound != STATS_INBOUND or matching_inbounds:
                raise XrayStatsError("Xray 本机统计套接字或标签与现有入站冲突。")
            matching_inbounds += 1
            continue
        if inbound.get("protocol") != "vless":
            continue
        clients = _object(inbound.get("settings", {}), "入站 settings").get("clients", [])
        if not isinstance(clients, list):
            raise XrayStatsError("Xray VLESS 客户端列表格式无效。")
        for client in clients:
            _object(client, "VLESS 客户端")
            email = client.get("email")
            if not isinstance(email, str) or not MANAGED_EMAIL.fullmatch(email):
                continue
            level = client.get("level", 0)
            if type(level) is not int or not 0 <= level <= 0xFFFFFFFF:
                raise XrayStatsError("Xray VLESS 用户等级无效，无法启用流量统计。")
            levels_to_enable.add(level)
    for outbound in outbounds:
        _object(outbound, "出站")
        if outbound.get("tag") in {STATS_API_TAG, STATS_INBOUND_TAG}:
            raise XrayStatsError("Xray 统计 API 标签与现有出站冲突。")
    retained_rules = []
    for rule in rules:
        _object(rule, "路由规则")
        inbound_tags = rule.get("inboundTag", [])
        if rule.get("outboundTag") == STATS_API_TAG or (
            isinstance(inbound_tags, list) and STATS_INBOUND_TAG in inbound_tags
        ):
            if rule != STATS_RULE:
                raise XrayStatsError("Xray 统计 API 只能由本机专用入站访问。")
        else:
            retained_rules.append(rule)
    _object(result.setdefault("stats", {}), "stats")
    policy = _object(result.setdefault("policy", {}), "policy")
    levels = _object(policy.setdefault("levels", {}), "policy.levels")
    for level in levels_to_enable:
        entry = _object(levels.setdefault(str(level), {}), f"policy.levels.{level}")
        entry.update(statsUserUplink=True, statsUserDownlink=True)
    result["api"] = copy.deepcopy(STATS_API)
    # Relay projections rebuild their own inbounds. Keep ours at a stable end
    # position so repeated combined renders are byte-for-byte equivalent.
    result["inbounds"] = [item for item in inbounds if item.get("tag") != STATS_INBOUND_TAG]
    result["inbounds"].append(copy.deepcopy(STATS_INBOUND))
    routing["rules"] = [copy.deepcopy(STATS_RULE), *retained_rules]
    return result


def stats_enabled(config: dict) -> bool:
    """Read-only recognition: never query an arbitrary or public API endpoint."""
    try:
        return isinstance(config, dict) and config.get("api") == STATS_API and render_xray_stats(config) == config
    except (XrayStatsError, TypeError, RecursionError):
        return False
