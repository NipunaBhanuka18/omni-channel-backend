param (
    [string]$ApiId = ""
)

$ErrorActionPreference = "Stop"

# Auto-detect REST API ID from terraform output if not explicitly provided
if ([string]::IsNullOrWhiteSpace($ApiId)) {
    Write-Host "[Runner] Auto-detecting REST API ID from Terraform outputs..." -ForegroundColor Cyan
    $infraDir = Join-Path $PSScriptRoot "..\..\infra"
    if (Test-Path $infraDir) {
        $terraformOutput = & terraform -chdir="$infraDir" output -raw api_gateway_rest_api_id 2>$null
        if ($LASTEXITCODE -eq 0 -and !([string]::IsNullOrWhiteSpace($terraformOutput))) {
            $ApiId = $terraformOutput.Trim()
            Write-Host "[Runner] Found API Gateway REST API ID: $ApiId" -ForegroundColor Green
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ApiId)) {
    Write-Host "❌ Error: REST API ID could not be detected. Please pass -ApiId <id> as a parameter." -ForegroundColor Red
    exit 1
}

$baseUrl = "http://localhost:4566/restapis/$ApiId/dev/_user_request_/route"
Write-Host "==========================================================================" -ForegroundColor Yellow
Write-Host "       RUNNING INGRESS & RBAC VERIFICATION SUITE AGAINST LOCALSTACK       " -ForegroundColor Yellow
Write-Host "Target Endpoint: $baseUrl" -ForegroundColor Yellow
Write-Host "==========================================================================" -ForegroundColor Yellow
Write-Host ""

$scriptDir = $PSScriptRoot
$passCount = 0
$totalTests = 8

# Helper to run curl using file payload @filename.json to avoid shell quoting issues
function Test-Endpoint {
    param (
        [string]$TestName,
        [string]$JsonFile,
        [string]$AuthToken,
        [string]$ExpectedPattern,
        [string]$Description
    )

    Write-Host "--------------------------------------------------------------------------" -ForegroundColor Gray
    Write-Host "TEST: $TestName" -ForegroundColor Cyan
    Write-Host "Desc: $Description" -ForegroundColor Gray
    Write-Host "Payload: @$JsonFile | Auth: Bearer $AuthToken" -ForegroundColor Gray

    $jsonPath = Join-Path $scriptDir $JsonFile
    if (-not (Test-Path $jsonPath)) {
        Write-Host "❌ FAIL: Payload file not found at $jsonPath" -ForegroundColor Red
        return $false
    }

    # Execute curl.exe reading payload directly from file
    $rawResponse = & curl.exe -s -X POST "$baseUrl" `
        -H "Authorization: Bearer $AuthToken" `
        -H "x-tenant-id: slt" `
        -H "x-channel: web" `
        -H "Content-Type: application/json" `
        -d "@$jsonPath"

    Write-Host "Raw Response: $rawResponse" -ForegroundColor White

    if ($rawResponse -match $ExpectedPattern) {
        Write-Host "Result: ✅ PASS" -ForegroundColor Green
        return $true
    } else {
        Write-Host "Result: ❌ FAIL (Expected pattern '$ExpectedPattern' not found in response)" -ForegroundColor Red
        return $false
    }
}

# ------------------------------------------------------------------------------
# Test Case 1: Valid check_balance request (dev-token-staff has billing:read)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "1. Valid Case: Billing check_balance (Authorized Staff)" `
    -JsonFile "valid-check-balance.json" `
    -AuthToken "dev-token-staff" `
    -ExpectedPattern '"success"\s*:\s*true' `
    -Description "Request with billing:read permission calling check_balance intent should succeed (HTTP 200)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 2: Denied check_balance request (dev-token-guest lacks billing:read)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "2. Denied Case: Billing check_balance (Unauthorized Guest)" `
    -JsonFile "denied-check-balance.json" `
    -AuthToken "dev-token-guest" `
    -ExpectedPattern '"code"\s*:\s*"FORBIDDEN"' `
    -Description "Request lacking billing:read permission calling check_balance intent should fail with FORBIDDEN (HTTP 403)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 3: Unmapped intent request (unmapped_unknown_intent fails closed)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "3. Unmapped Intent Case (Fail Closed Policy)" `
    -JsonFile "unmapped-intent.json" `
    -AuthToken "dev-token-staff" `
    -ExpectedPattern 'unmapped_intent' `
    -Description "Request calling unmapped intent should fail closed with FORBIDDEN unmapped_intent error (HTTP 403)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 4: Malformed JSON request (Strict Input Validation)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "4. Malformed JSON Case (Strict Validation)" `
    -JsonFile "malformed.json" `
    -AuthToken "dev-token-staff" `
    -ExpectedPattern '"code"\s*:\s*"BAD_REQUEST"' `
    -Description "Request containing invalid JSON syntax should be strictly rejected with BAD_REQUEST (HTTP 400)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 5: Valid check_usage request (dev-token-staff has usage:read)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "5. Valid Case: Usage check_usage (Authorized Staff)" `
    -JsonFile "valid-check-usage.json" `
    -AuthToken "dev-token-staff" `
    -ExpectedPattern '"success"\s*:\s*true' `
    -Description "Request with usage:read permission calling check_usage intent should succeed (HTTP 200)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 6: Denied check_usage request (dev-token-billing-only lacks usage:read)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "6. Denied Case: Usage check_usage (Unauthorized Billing-Only User)" `
    -JsonFile "denied-check-usage.json" `
    -AuthToken "dev-token-billing-only" `
    -ExpectedPattern '"code"\s*:\s*"FORBIDDEN"' `
    -Description "Request lacking usage:read permission calling check_usage intent should fail with FORBIDDEN (HTTP 403)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 7: Valid troubleshoot_router request (dev-token-staff has faults:read)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "7. Valid Case: Support troubleshoot_router (Authorized Staff)" `
    -JsonFile "valid-troubleshoot.json" `
    -AuthToken "dev-token-staff" `
    -ExpectedPattern '"success"\s*:\s*true' `
    -Description "Request with faults:read permission calling troubleshoot_router intent should succeed (HTTP 200)") {
    $passCount++
}

# ------------------------------------------------------------------------------
# Test Case 8: Denied troubleshoot_router request (dev-token-billing-only lacks faults:read)
# ------------------------------------------------------------------------------
if (Test-Endpoint `
    -TestName "8. Denied Case: Support troubleshoot_router (Unauthorized Billing-Only User)" `
    -JsonFile "denied-troubleshoot.json" `
    -AuthToken "dev-token-billing-only" `
    -ExpectedPattern '"code"\s*:\s*"FORBIDDEN"' `
    -Description "Request lacking faults:read permission calling troubleshoot_router intent should fail with FORBIDDEN (HTTP 403)") {
    $passCount++
}

Write-Host ""
Write-Host "==========================================================================" -ForegroundColor Yellow
if ($passCount -eq $totalTests) {
    Write-Host " SUMMARY: ALL $totalTests TESTS PASSED PERFECTLY ($passCount/$totalTests)" -ForegroundColor Green
} else {
    Write-Host " SUMMARY: $passCount/$totalTests TESTS PASSED" -ForegroundColor Red
}
Write-Host "==========================================================================" -ForegroundColor Yellow
