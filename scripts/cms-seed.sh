#!/usr/bin/env bash
# Seed the CMS with an OAuth2 app and test display group.
# Used by CI after Docker Compose CMS starts.
# For dev CMS (xibo-dev.superpantalles.com), seeding is done manually once.
#
# Env vars:
#   CMS_URL       — CMS base URL (e.g., http://localhost:18080)
#   CMS_ADMIN_USER — admin username (default: xibo_admin)
#   CMS_ADMIN_PASS — admin password (default: password)
#   CLIENT_ID     — existing OAuth2 client id, if the CMS was provisioned
#   CLIENT_SECRET — its secret. On CMS 4.x a client created here gets a
#                   server-generated id and secret, which are written to
#                   GITHUB_ENV as SEEDED_CLIENT_ID / SEEDED_CLIENT_SECRET
#                   so later CI steps pick them up.

set -euo pipefail

CMS_URL="${CMS_URL:?CMS_URL is required}"
CMS_ADMIN_USER="${CMS_ADMIN_USER:-xibo_admin}"
CMS_ADMIN_PASS="${CMS_ADMIN_PASS:-password}"
CLIENT_ID="${CLIENT_ID:-ci-test-client}"
CLIENT_SECRET="${CLIENT_SECRET:-ci-test-secret}"
CLIENT_NAME="${CLIENT_NAME:-CI Test Client}"

echo "[seed] Waiting for CMS at $CMS_URL..."
for i in $(seq 1 60); do
  # /api/about requires OAuth on CMS 4.x (401), so probe the login page.
  if curl -sf "$CMS_URL/login" > /dev/null 2>&1; then
    echo "[seed] CMS is ready"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[seed] ERROR: CMS did not start within 5 minutes"
    exit 1
  fi
  sleep 5
done

# Get admin token via password grant (CMS built-in client)
echo "[seed] Authenticating as admin..."
TOKEN=$(curl -sf "$CMS_URL/api/authorize/access_token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" 2>/dev/null | jq -r '.access_token // empty' || true)

if [ -z "$TOKEN" ]; then
  # Create the application through the admin session.
  #
  # CMS 4.x changed all three moving parts this used to rely on: the login
  # page is a JS app (the CSRF token lives in a <meta name="token"> tag, not
  # a form field), /application/add is gone in favour of the /json/ API, and
  # the CMS generates the client id and secret itself — they can no longer be
  # chosen. So the requested CLIENT_ID/CLIENT_SECRET only apply to a CMS that
  # was provisioned outside this script; otherwise we adopt what we are given
  # back and export it for later steps.
  echo "[seed] OAuth client not usable — creating one via the admin session..."
  COOKIE_JAR=$(mktemp)
  trap 'rm -f "$COOKIE_JAR"' EXIT

  CSRF=$(curl -sf -c "$COOKIE_JAR" "$CMS_URL/login" \
    | grep -oP 'name="token" content="\K[^"]+' || true)
  if [ -z "$CSRF" ]; then
    echo "[seed] WARNING: no CSRF token on the login page; cannot create a client."
    exit 0
  fi

  LOGIN=$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST "$CMS_URL/login" \
    -H "X-XSRF-TOKEN: $CSRF" \
    -d "username=$CMS_ADMIN_USER" \
    -d "password=$CMS_ADMIN_PASS" || true)
  if ! echo "$LOGIN" | grep -q '"status":"ok"'; then
    echo "[seed] WARNING: admin login failed for '$CMS_ADMIN_USER' — $LOGIN"
    exit 0
  fi

  # The token rotates with the session, so read it again after logging in.
  CSRF=$(curl -sf -b "$COOKIE_JAR" "$CMS_URL/login" \
    | grep -oP 'name="token" content="\K[^"]+' || true)

  echo "[seed] Creating OAuth2 application..."
  APP=$(curl -sf -b "$COOKIE_JAR" -X POST "$CMS_URL/json/application" \
    -H "Content-Type: application/json" \
    -H "X-XSRF-TOKEN: $CSRF" \
    -d "{\"name\":\"$CLIENT_NAME\"}" || true)
  CLIENT_ID=$(echo "$APP" | jq -r '.key // empty')
  CLIENT_SECRET=$(echo "$APP" | jq -r '.secret // empty')

  if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
    echo "[seed] WARNING: could not create an application — $APP"
    exit 0
  fi

  # A new application has no grants and no scopes. Turn on client_credentials,
  # and grant the "all" scope — the CMS's edit endpoint replaces the scope set
  # on every PUT (Applications::edit() does `scopes = []` then re-assigns only
  # the `scope_<id>` checkboxes present in the request), so an application
  # with none checked ends up with zero scopes: every API route requiring a
  # scope then 403s, even though the client_credentials token itself is
  # valid. With no scope requested at token time, the CMS hands back a token
  # carrying every scope assigned to the client (ApplicationScopeFactory::
  # finalizeScopes), and "all" short-circuits the per-route scope check in
  # ApiAuthorization::process — so this one checkbox is enough for the whole
  # surface the integration tests exercise (Resolutions, Layouts, Library,
  # Campaigns, Displays, Schedules, ...).
  curl -sf -b "$COOKIE_JAR" -X PUT "$CMS_URL/json/application/$CLIENT_ID" \
    -H "Content-Type: application/json" \
    -H "X-XSRF-TOKEN: $CSRF" \
    -d "{\"name\":\"$CLIENT_NAME\",\"authCode\":0,\"clientCredentials\":1,\"isConfidential\":1,\"scope_all\":1}" \
    > /dev/null || true

  # Hand the generated credentials to the steps that follow.
  if [ -n "${GITHUB_ENV:-}" ]; then
    {
      echo "SEEDED_CLIENT_ID=$CLIENT_ID"
      echo "SEEDED_CLIENT_SECRET=$CLIENT_SECRET"
    } >> "$GITHUB_ENV"
    echo "[seed] Exported the generated credentials to GITHUB_ENV"
  fi

  TOKEN=$(curl -sf "$CMS_URL/api/authorize/access_token" \
    -d "grant_type=client_credentials" \
    -d "client_id=$CLIENT_ID" \
    -d "client_secret=$CLIENT_SECRET" | jq -r '.access_token // empty' || true)
fi

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "[seed] WARNING: Could not obtain OAuth token. Integration tests may fail."
  exit 0
fi

echo "[seed] Authenticated. Creating test data..."

# Create a test display group
curl -sf "$CMS_URL/api/displaygroup" \
  -H "Authorization: Bearer $TOKEN" \
  -d "displayGroup=CI Test Displays" \
  -d "description=Auto-created by CI seed script" > /dev/null 2>&1 || true

# Create a simple test layout
curl -sf "$CMS_URL/api/layout" \
  -H "Authorization: Bearer $TOKEN" \
  -d "name=CI Test Layout" \
  -d "description=Auto-created by CI seed script" \
  -d "resolutionId=9" > /dev/null 2>&1 || true

echo "[seed] CMS seeded successfully"
