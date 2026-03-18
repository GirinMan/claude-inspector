우선 README.md와 DEVELOPMENT_GUIDE.md를 참고하여 맥락을 충분히 파악한다.

이 프로젝트는 훌륭하지만 3가지 개선점이 있다.
기존 서비스의 첫 시작 화면 등을 최대한 건드리지 않는 선에서 구현한다.

참고로 나는 .bashrc 또는 .zshrc에 Bedrock API를 이용해 아래처럼 claude code를 설정하고 있음:

```bash
export AWS_BEARER_TOKEN_BEDROCK=ABSK...

# Enable Bedrock integration
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=ap-northeast-2  # or your preferred region

export ANTHROPIC_DEFAULT_OPUS_MODEL='global.anthropic.claude-opus-4-6-v1'
export ANTHROPIC_DEFAULT_SONNET_MODEL='global.anthropic.claude-sonnet-4-6'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='global.anthropic.claude-haiku-4-5-20251001-v1:0'
```

---

## 이슈 1+2: Target URL 설정 + Third-party API (Bedrock 등) 지원

### 문제
- `main.js:151,153`에 `api.anthropic.com`이 하드코딩되어 있어 base url을 변경할 수 없음
- Bedrock, Azure 등 third-party API를 source로 사용하는 경우 트래킹 불가

### 해결 방향
프록시를 "Anthropic 전용"에서 "투명 HTTP 프록시"로 전환한다.

### 수정 범위

**main.js (L151-153)**
- `proxy-start` IPC 호출 시 `targetUrl` 파라미터 추가
- `new URL(targetUrl)`로 파싱하여 `hostname`, `port`, `protocol(https/http)` 추출
- `host` 헤더를 target URL의 호스트로 동적 설정
- 요청 포워딩 시 헤더/경로 변조 없이 그대로 전달

**preload.js**
- `proxyStart(port, targetUrl)` 시그니처 변경

**public/index.html**
- Proxy 패널에 Target URL 입력 필드 추가 (기본값 `https://api.anthropic.com`)
- Start 시 target URL을 함께 전달
- Bedrock 사용 시 예: `https://bedrock-runtime.ap-northeast-2.amazonaws.com`

**파싱 호환성**
- 응답 JSON 구조가 Anthropic 형식이 아닌 경우 raw로 표시하는 fallback 추가
- `parseSseStream()`은 범용 SSE 파서이므로 큰 변경 불필요

### 작업량
main.js 10줄 내외 수정 + UI 입력 필드 1개. 소규모.

---

## 이슈 3: 원격 프록시 서버 (Docker)

### 문제
프록시가 Electron 앱 내부에서만 실행됨. 사내 공용 Claude API 서버를 감싸서 로컬에서 실행하지 않은 Claude Code 실행 로그도 확인하려면, 별도 프록시 서버를 원격에 띄우고 UI에서 연결하는 옵션이 필요하다.

### 해결 방향

#### A. 프록시 서버 분리 (`proxy-server/`)
- `main.js`의 프록시 로직(L129-205, SSE 파서 L34-60)을 독립 Node.js 패키지로 추출
- `proxy-server/index.js` — CLI로 실행 가능한 standalone HTTP 프록시
- 캡처된 요청/응답을 WebSocket으로 연결된 클라이언트에 브로드캐스트
- `proxy-server/Dockerfile` — `node:20-alpine` 기반, 프록시 포트 9090 + WS 포트 9091 노출

#### B. Electron 앱에 "Remote" 모드 추가
- UI에 모드 토글: Local Proxy (현재) / Remote Proxy
- Remote 모드: WebSocket URL 입력 (예: `ws://internal-server:9091`)
- WS로 수신한 request/response를 기존 `proxyCaptures` 배열에 동일하게 주입
- 기존 UI 코드 재사용 — 데이터 소스만 IPC에서 WebSocket으로 교체

#### C. 디렉토리 구조
```
claude-inspector/
  main.js              # Electron main (Local 모드: 내장 프록시 사용)
  proxy-server/
    index.js           # Standalone proxy + WS broadcaster
    Dockerfile
    package.json
  public/
    index.html         # Remote 모드 UI 추가
```

#### D. 사용 시나리오
```bash
# 사내 서버에서
docker run -p 9090:9090 -p 9091:9091 claude-inspector-proxy \
  --target https://bedrock-runtime.ap-northeast-2.amazonaws.com

# 개발자 로컬에서
# Claude Inspector 앱 -> Remote 모드 -> ws://internal-server:9091 연결
# 사내 Claude Code 사용자들: ANTHROPIC_BASE_URL=http://internal-server:9090 claude
```

### 작업량
아키텍처 변경 포함. 대규모.

---

## 구현 순서

1. **이슈 1+2** (소규모) — Target URL 설정 + 투명 프록시화. 기존 코드 수정만으로 완료.
2. **이슈 3** (대규모) — 프록시 서버 분리 -> Docker화 -> Remote 모드 UI.
