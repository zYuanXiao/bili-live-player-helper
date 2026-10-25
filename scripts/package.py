"""Package the unpacked extension without development artifacts."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "extension"
FILES = (
    "manifest.json", "background.js", "core.js", "content.js",
    "page-media-bridge.js", "popup.html", "popup.css", "popup.js",
    "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png",
)


def main():
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected a three-part numeric extension version")
    referenced = {"manifest.json", manifest["background"]["service_worker"], manifest["action"]["default_popup"]}
    referenced.update(manifest["icons"].values())
    referenced.update(manifest["action"]["default_icon"].values())
    for entry in manifest["content_scripts"]:
        referenced.update(entry["js"])
    popup = (EXTENSION / manifest["action"]["default_popup"]).read_text(encoding="utf-8")
    referenced.update(re.findall(r'(?:src|href)="([^"]+)"', popup))
    if referenced != set(FILES):
        raise ValueError("Update the reviewed runtime file list before packaging")
    destination = ROOT / "dist"
    destination.mkdir(exist_ok=True)
    output = destination / f"bili-live-player-helper-v{version}.zip"
    instructions = f"""B站直播海外观看助手 v{version}

安装（Chrome / Edge，Chromium 111 或更新版本）：
1. 右键 ZIP，选择“全部解压”，解压到一个长期保留的文件夹。
2. Chrome 地址栏打开 chrome://extensions；Edge 打开 edge://extensions。
3. 打开“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择本说明所在的文件夹，其中直接包含 manifest.json。
5. 在浏览器扩展菜单中固定“B站直播播放器助手”，然后刷新直播间。

使用：
受限时默认自动尝试备用播放器；也可点击左下角或工具栏插件手动切换。
点击“恢复原播放器”可还原；面板右侧箭头可收起说明。
画质、线路、声音和全屏使用视频内的官方菜单。房间只有原画时不会新增低清档位。
浏览器阻止自动播放时，请点击视频中的播放按钮。
播放失败可尝试“重新载入”或“独立打开”；卡顿可查看工具栏插件里的“播放诊断”。

更新：
用新版文件覆盖原文件夹，在扩展管理页点击“重新加载”，再刷新直播间。
解压后的插件文件夹需要保留；ZIP 可以删除。停用或卸载后也请刷新直播间。

无需安装 Node.js、Python、代理或额外服务器。
本插件尝试使用B站官方备用播放入口，不修改DNS或系统网络设置。
能否播放、可选画质和线路取决于B站当前提供的内容与访问策略。
"""
    def add(archive, name, content):
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, content, compresslevel=9)

    with zipfile.ZipFile(output, "w") as archive:
        for name in sorted(FILES):
            file = EXTENSION / name
            if file.is_symlink() or not file.resolve().is_relative_to(EXTENSION.resolve()):
                raise ValueError(f"Invalid runtime asset: {name}")
            content = file.read_bytes() if name.endswith(".png") else file.read_text(encoding="utf-8").encode("utf-8")
            add(archive, name, content)
        add(archive, "安装说明.txt", instructions.encode("utf-8"))
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != set(FILES) | {"安装说明.txt"}:
            raise ValueError("Package validation failed")
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    (destination / "SHA256SUMS.txt").write_text(
        f"{checksum}  {output.name}\n", encoding="utf-8"
    )
    print(f"Built: {output}")
    print(f"SHA256: {checksum}")


if __name__ == "__main__":
    main()
