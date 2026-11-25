param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$ServiceName = "rubriccheck-qa"
)

$ErrorActionPreference = "Stop"

Write-Host "Deploying $ServiceName to Google Cloud Run ($ProjectId / $Region)..."
gcloud run deploy $ServiceName `
  --project=$ProjectId `
  --region=$Region `
  --source=. `
  --allow-unauthenticated `
  --memory=512Mi `
  --cpu=1 `
  --min-instances=0 `
  --max-instances=10 `
  --set-env-vars="NODE_ENV=production,PADDLE_ENV=sandbox,GEMINI_DECISION_MODEL=gemini-decision-1" `
  --quiet

Write-Host "Deployment submitted. Configure secrets (GEMINI_API_KEY, ENCRYPTION_KEY, SESSION_SECRET, ZENDESK_OAUTH_CLIENT_SECRET, PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET) before production traffic."
