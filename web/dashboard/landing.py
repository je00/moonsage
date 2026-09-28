"""A lightweight entry page, independent of management-agent availability."""

from django.shortcuts import render
from django.views.decorators.http import require_safe


COPY = {
    "zh": {
        "title": "moonsage · 内网互联",
        "description": "以一台 VPS 为中心，连接内网设备，按目标和端口管理访问权限。",
        "skip": "跳到主要内容",
        "home": "moonsage 首页",
        "language": "首页语言",
        "navigation": "快速入口",
        "console": "控制台",
        "enter": "进入控制台",
        "start": "开始部署",
        "network": "内网互联",
        "permissions": "访问权限",
        "guide": "部署指南",
        "theme": "外观",
        "theme_dark": "暗色",
        "theme_light": "亮色",
    },
    "en": {
        "title": "moonsage · Private network",
        "description": "Connect your devices through one VPS. Control access by device, protocol and port.",
        "skip": "Skip to content",
        "home": "moonsage home",
        "language": "Home page language",
        "navigation": "Quick links",
        "console": "Console",
        "enter": "Open console",
        "start": "Get started",
        "network": "Your network",
        "permissions": "Access rules",
        "guide": "Setup guide",
        "theme": "Theme",
        "theme_dark": "Dark",
        "theme_light": "Light",
    },
}


@require_safe
def home(request):
    language = request.GET.get("lang", "zh")
    if language not in COPY:
        language = "zh"
    return render(request, "dashboard/home.html", {
        "landing_language": language,
        "copy": COPY[language],
    })
