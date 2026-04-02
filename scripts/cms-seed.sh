#!/usr/bin/env bash
# Seed the CMS with an OAuth2 app and test display group.
# Used by CI after Docker Compose CMS starts.
# For dev CMS (xibo-dev.superpantalles.com), seeding is done manually once.
#
# Env vars:
#   CMS_URL       — CMS base URL (e.g., http://localhost:18080)
#   CMS_ADMIN_USER — admin username (default: admin)
#   CMS_ADMIN_PASS — admin password (default: password)
#   CLIENT_ID     — OAuth2 client ID to create
#   CLIENT_SECRET — OAuth2 client secret to create

set -euo pipefail

CMS_URL="${CMS_URL:?CMS_URL is required}"
CMS_ADMIN_USER="${CMS_ADMIN_USER:-admin}"
CMS_ADMIN_PASS="${CMS_ADMIN_PASS:-password}"
CLIENT_ID="${CLIENT_ID:-ci-test-client}"
CLIENT_SECRET="${CLIENT_SECRET:-ci-test-secret}"

echo "[seed] Waiting for CMS at $CMS_URL..."
for i in $(seq 1 60); do
  if curl -sf "$CMS_URL/api/about" > /dev/null 2>&1; then
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
  echo "[seed] OAuth client not found — creating via admin session..."
  # Fall back to cookie-based admin login to create the OAuth app
  COOKIE_JAR=$(mktemp)
  trap "rm -f $COOKIE_JAR" EXIT

  # Login to web UI
  curl -sf -c "$COOKIE_JAR" "$CMS_URL/login" > /dev/null
  CSRF=$(curl -sf -b "$COOKIE_JAR" "$CMS_URL/login" | grep -oP 'name="token" value="\K[^"]+' || true)

  if [ -n "$CSRF" ]; then
    curl -sf -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$CMS_URL/login" \
      -d "username=$CMS_ADMIN_USER" \
      -d "password=$CMS_ADMIN_PASS" \
      -d "token=$CSRF" > /dev/null 2>&1

    echo "[seed] Creating OAuth2 application..."
    curl -sf -b "$COOKIE_JAR" "$CMS_URL/application/add" \
      -d "name=CI Test Client" \
      -d "clientId=$CLIENT_ID" \
      -d "clientSecret=$CLIENT_SECRET" \
      -d "authCode=0" \
      -d "clientCredentials=1" > /dev/null 2>&1 || echo "[seed] OAuth app may already exist"
  fi

  # Try again
  TOKEN=$(curl -sf "$CMS_URL/api/authorize/access_token" \
    -d "grant_type=client_credentials" \
    -d "client_id=$CLIENT_ID" \
    -d "client_secret=$CLIENT_SECRET" | jq -r '.access_token')
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
