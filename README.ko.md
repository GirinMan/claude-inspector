<div align="center">

# Claude Inspector

**Claude Code가 API에 실제로 무엇을 보내는지 확인하세요.**

Claude Code CLI 트래픽을 실시간으로 가로채<br>
5가지 프롬프트 증강 메커니즘을 모두 시각화하는 MITM 프록시.

[기능](#기능) · [설치](#설치) · [배울 수 있는 것들](#배울-수-있는-것들) · [프록시 모드](#프록시-모드) · [기술 스택](#기술-스택)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/kangraemin/claude-inspector)](https://github.com/kangraemin/claude-inspector/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black)](https://github.com/kangraemin/claude-inspector/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-arm64%20%7C%20x64-orange)](https://github.com/kangraemin/claude-inspector/releases/latest)

[English](README.md) | **한국어**

</div>

---

<p align="center">
  <img src="public/screenshots/ko-1.png" width="100%" alt="Proxy — Analysis 뷰" />
</p>

<p align="center">
  <img src="public/screenshots/ko-2.png" width="100%" alt="Proxy — Request 뷰 (비용 분석)" />
</p>

<p align="center">
  <img src="public/screenshots/ko-3.png" width="100%" alt="Proxy — Request 뷰" />
</p>

## 기능

### 🔍 로컬 및 원격 프록시 모드
- **로컬 모드**: 내 컴퓨터에서 MITM 프록시 실행 (`localhost:9090`)
- **원격 모드**: WebSocket을 통해 원격 프록시 서버에 연결하여 분산 디버깅
- 탭 기반 UI로 모드 간 원활한 전환

### 🌐 다중 제공자 지원
- **Anthropic 직접 API**: `api.anthropic.com` 트래픽 인터셉트
- **AWS Bedrock**: Amazon Bedrock Claude API 완전 지원
  - AWS Event Stream 파서 (base64로 인코딩된 스트리밍 응답 처리)
  - 사전 구성된 AWS 리전 선택기 (주요 12개 리전 + 커스텀)
  - 자동 `ANTHROPIC_BEDROCK_BASE_URL` 구성

### 🖥️ 크로스 플랫폼
- **macOS**: arm64 & x64 (Homebrew 또는 직접 다운로드로 `.dmg` 제공)
- **Linux**: arm64 & x64 (`.AppImage` & `.deb` 패키지)
- **Windows**: x64 (NSIS 인스톨러)

### 📊 실시간 트래픽 분석
- 구문 강조가 적용된 실시간 요청/응답 캡처
- 요청별 토큰 비용 분석
- 메시지 흐름 시각화
- SSE 스트림을 완전한 JSON으로 재조립

## 배울 수 있는 것들

아래 내용은 모두 **실제 캡처된 트래픽**에서 발견한 것입니다. Claude Code가 감추고 있는 것을 확인하세요.

### 1. CLAUDE.md는 매 요청마다 주입된다

`hello`를 입력하면, Claude Code는 메시지 앞에 **~12KB**를 자동으로 추가합니다:

| 블록 | 내용 | 크기 |
|------|------|------|
| `content[0]` | 사용 가능한 스킬 목록 | ~2KB |
| `content[1]` | CLAUDE.md + rules + memory | **~10KB** |
| `content[2]` | 실제로 입력한 내용 | 수 바이트 |

**주입 순서:** 글로벌 CLAUDE.md → 글로벌 rules → 프로젝트 CLAUDE.md → Memory

이 ~12KB 페이로드는 **매 요청마다** 재전송됩니다. 500줄짜리 CLAUDE.md는 모든 API 호출에서 조용히 토큰을 소모합니다. 간결하게 유지하세요.

### 2. MCP 도구는 지연 로드된다 — `tools[]`가 늘어나는 것을 확인하세요

빌트인 도구(27개)는 매 요청마다 전체 JSON 스키마를 전송합니다. MCP 도구는 그렇지 않습니다 — 처음에는 **이름만** 존재합니다.

**실시간으로 개수가 변하는 것을 확인하세요:**

| 단계 | 발생하는 일 | `tools[]` 개수 |
|------|------------|---------------|
| 초기 요청 | 27개 빌트인 도구 로드 | **27** |
| 모델이 `ToolSearch("context7")` 호출 | 2개 MCP 도구 전체 스키마 반환 | **29** |
| 모델이 `ToolSearch("til")` 호출 | 6개 MCP 도구 스키마 추가 | **35** |

사용하지 않는 MCP 도구는 토큰을 소비하지 않습니다. Inspector로 모델이 필요한 도구를 발견할 때 `tools[]`가 늘어나는 것을 확인할 수 있습니다.

### 3. 이미지는 base64로 인라인 인코딩된다

Claude Code가 스크린샷이나 이미지 파일을 읽을 때, 이미지는 **base64로 인코딩되어 JSON 본문에 직접 포함**됩니다:

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgo..."
  }
}
```

스크린샷 하나가 요청 페이로드에 **수백 KB**를 추가할 수 있습니다. Inspector로 정확한 크기를 확인할 수 있습니다.

### 4. Skill ≠ Command — 완전히 다른 주입 경로

`/something`을 입력하면 세 가지 완전히 다른 메커니즘 중 하나가 작동합니다:

| | 로컬 커맨드 | 사용자 스킬 | 어시스턴트 스킬 |
|---|---|---|---|
| **예시** | `/mcp`, `/clear` | `/commit` | `Skill("finish")` |
| **트리거** | 사용자 | 사용자 | 모델 |
| **주입** | `<local-command-stdout>` | user msg에 전체 프롬프트 | `tool_use` → `tool_result` |
| **모델에 전달** | 결과만 | 전체 프롬프트 | 전체 프롬프트 |

**커맨드**는 로컬에서 실행되어 결과만 전달합니다. **스킬**은 프롬프트 전체를 주입하며 — 세션이 끝날 때까지 **이후 모든 요청에 남습니다**.

### 5. 이전 메시지가 계속 쌓인다 — `/clear`를 자주 사용하세요

Claude Code는 매 요청마다 `messages[]` 배열 **전체**를 재전송합니다:

```json
{
  "messages": [
    {"role": "user",      "content": [/* ~12KB CLAUDE.md */ , "hello"]},
    {"role": "assistant", "content": [/* tool_use, thinking, response */]},
    {"role": "user",      "content": [/* ~12KB CLAUDE.md */ , "fix the bug"]},
    {"role": "assistant", "content": [/* tool_use, thinking, response */]},
    // ... 30턴 = CLAUDE.md 30개 복사본 + 모든 응답
  ]
}
```

| 턴 수 | 대략적인 누적 전송량 |
|-------|---------------------|
| 1 | ~15KB |
| 10 | ~200KB |
| 30 | ~1MB+ |

대부분은 더 이상 필요 없는 이전 대화입니다. 누적될수록:

- **비용 증가** — 요청당 입력 토큰이 늘어나 API 비용이 올라감
- **컨텍스트 윈도우 포화** — 한계에 도달하면 이전 메시지가 자동 압축되어 세부 내용이 유실됨
- **응답 속도 저하** — 페이로드가 클수록 처리 시간이 길어짐

`/clear`를 실행하면 컨텍스트가 초기화되고 누적된 무게가 사라집니다. 자주 정리하세요.

### 6. 서브 에이전트는 완전히 격리된 컨텍스트에서 실행된다

Claude Code가 서브 에이전트를 생성하면(`Agent` 도구 사용), **완전히 별도의 API 호출**이 만들어집니다. 부모와 서브 에이전트는 완전히 다른 `messages[]`를 가집니다:

| | 부모 API 호출 | 서브 에이전트 API 호출 |
|---|---|---|
| **`messages[]`** | 전체 대화 이력 (모든 턴) | 작업 프롬프트만 — **부모 이력 없음** |
| **CLAUDE.md** | 포함됨 | 포함됨 (독립적으로) |
| **tools[]** | 로드된 모든 도구 | 새로운 세트 |
| **컨텍스트** | 누적됨 | 0에서 시작 |

Inspector는 부모와 서브 에이전트 호출을 모두 캡처하므로, 각각이 무엇을 보는지 비교할 수 있습니다.

## 설치

### macOS

#### Homebrew (권장)

```bash
brew install --cask kangraemin/tap/claude-inspector && sleep 2 && open -a "Claude Inspector"
```

#### 직접 다운로드

[Releases](https://github.com/kangraemin/claude-inspector/releases/latest) 페이지에서 `.dmg`를 다운로드하세요.

| Mac (Apple Silicon) | Mac (Intel) |
|---|---|
| [Claude-Inspector-arm64.dmg](https://github.com/kangraemin/claude-inspector/releases/latest) | [Claude-Inspector-x64.dmg](https://github.com/kangraemin/claude-inspector/releases/latest) |

### Linux

[Releases](https://github.com/kangraemin/claude-inspector/releases/latest) 페이지에서 다운로드:

| 형식 | 설명 |
|---|---|
| `.AppImage` | 범용 Linux 바이너리 (x64/arm64) - 설치 불필요, 실행 권한만 부여하고 실행 |
| `.deb` | Debian/Ubuntu 패키지 (x64/arm64) |

**AppImage:**
```bash
chmod +x Claude-Inspector-*.AppImage
./Claude-Inspector-*.AppImage
```

**Debian/Ubuntu:**
```bash
sudo dpkg -i Claude-Inspector-*.deb
```

### 업그레이드

```bash
brew update && brew upgrade --cask claude-inspector && sleep 2 && open -a "Claude Inspector"
```

### 삭제

```bash
brew uninstall --cask claude-inspector
```

## 개발 환경

### macOS / Windows
```bash
git clone https://github.com/kangraemin/claude-inspector.git
cd claude-inspector
npm install
npm start
```

### Linux (Ubuntu/Debian)
```bash
git clone https://github.com/kangraemin/claude-inspector.git
cd claude-inspector
npm install
npm run start:linux  # Linux에 필요한 --no-sandbox 플래그 사용
```

**Linux용 빌드:**
```bash
npm run dist:linux  # AppImage 및 .deb 패키지 빌드
```

## 프록시 모드

로컬 또는 원격 MITM 프록시를 통해 **실제** Claude Code CLI 트래픽을 인터셉트합니다.

### 로컬 모드 (기본)

```
Claude Code CLI  →  Inspector (localhost:9090)  →  api.anthropic.com / Bedrock
```

**1.** 앱에서 **Start Proxy** 클릭 (Local 탭)<br>
**2.** 대상 제공자 선택:
   - **Anthropic**: 직접 API (`api.anthropic.com`)
   - **Bedrock**: Amazon Bedrock (드롭다운에서 AWS 리전 선택)

**3.** 프록시를 통해 Claude Code 실행:

**Anthropic API:**
```bash
ANTHROPIC_BASE_URL=http://localhost:9090 claude
```

**AWS Bedrock:**
```bash
ANTHROPIC_BEDROCK_BASE_URL=http://localhost:9090 claude
```

**4.** 모든 API 요청/응답이 실시간으로 캡처됩니다.

### 원격 모드

분산 디버깅을 위해 원격 프록시 서버에 연결:

**1.** **Remote** 탭으로 전환<br>
**2.** WebSocket URL 입력 (예: `ws://your-server:9091`)<br>
**3.** **Connect** 클릭

사용 사례:
- 원격 서버에서 실행 중인 Claude Code 디버깅
- 팀 협업 (여러 개발자가 동일한 트래픽 모니터링)
- Docker/컨테이너 환경

> 🐳 **원격 프록시 서버**: 독립 실행형 프록시 서버를 Docker로 배포할 수 있습니다. 자세한 내용은 `proxy-server/` 디렉토리를 참조하세요.

## 기술 스택

| 레이어 | 기술 | 이유 |
|--------|------|------|
| **Electron** | 데스크탑 셸, main/renderer 간 IPC | 네이티브 macOS 타이틀바(`hiddenInset`), 코드 서명 + 공증된 DMG 배포 |
| **Vanilla JS** | 프레임워크 없음, 빌드 단계 없음 | 전체 UI가 단일 `index.html` — 번들러 없음, 트랜스파일러 없음, React 없음 |
| **Node `http`/`https`** | `localhost` MITM 프록시 | Claude Code ↔ Anthropic API 트래픽 인터셉트, SSE 스트림을 완전한 응답 객체로 재조립 |
| **highlight.js + marked** | 구문 강조 및 마크다운 | JSON 페이로드와 마크다운 콘텐츠를 인라인 렌더링 |

> **프라이버시**: 모든 트래픽은 `localhost`에서만 처리됩니다. `api.anthropic.com`으로 직접 전송되는 것 외에 어디에도 데이터를 보내지 않습니다.

## 라이선스

MIT
