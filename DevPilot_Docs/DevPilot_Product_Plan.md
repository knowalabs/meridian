# DevPilot Product Plan

## Vision

**One command to set up every AI coding tool on any machine.**

``` bash
curl -fsSL https://devpilot.sh/install | bash
# or
npm i -g devpilot
devpilot init
```

------------------------------------------------------------------------

# Phase 1 --- MVP (1--2 months)

## Features

### 1. Tool Detection

``` bash
devpilot doctor
```

Detects installed tools: - Git - Node.js - VS Code - Cursor - Claude
Code - Codex CLI - Gemini CLI - Docker

### 2. Tool Installation

``` bash
devpilot install claude
devpilot install all
```

Automatically installs and configures supported tools.

### 3. Secure API Key Vault

``` bash
devpilot auth
devpilot keys list
```

Stores keys securely using the operating system keychain.

Supported providers: - OpenAI - Anthropic - Google Gemini - OpenRouter

### 4. Project Initialization

``` bash
devpilot init
```

Creates:

    .devpilot/
    agents/
    prompts/
    rules/
    context/
    CLAUDE.md
    AGENTS.md
    README_AI.md

### 5. AI Context Generator

``` bash
devpilot scan
```

Generates: - Architecture summary - Folder structure - Dependencies -
Coding conventions - API summary

------------------------------------------------------------------------

# Phase 2 --- Rules Engine

``` bash
devpilot rules generate
```

Generates instruction files for: - Claude - Cursor - Codex - GitHub
Copilot - Gemini

------------------------------------------------------------------------

# Phase 3 --- MCP Marketplace

``` bash
devpilot mcp search firebase
devpilot mcp install github
```

Automatically configures supported AI tools.

------------------------------------------------------------------------

# Phase 4 --- AI Router

``` bash
devpilot ask
```

Routes requests to the most suitable provider based on cost, speed,
context size, or user preferences.

------------------------------------------------------------------------

# Phase 5 --- Cloud Sync

``` bash
devpilot login
```

Synchronizes: - API keys (encrypted) - Rules - Prompts - MCP
configuration - Preferences

------------------------------------------------------------------------

# Phase 6 --- Team Features

Organization-wide: - Shared rules - Shared prompts - Approved MCP
servers - Audit logs - Access control

------------------------------------------------------------------------

# Technology Stack

## CLI

-   TypeScript
-   Node.js
-   Commander.js or oclif

## Desktop (Future)

-   Tauri
-   React

## Backend

-   Go or Node.js
-   PostgreSQL
-   Redis

------------------------------------------------------------------------

# Pricing

## Free

-   Tool installation
-   Local configuration
-   Up to 3 API keys
-   Basic rules generation

## Pro (\$10/month)

-   Unlimited API keys
-   Cloud sync
-   AI router
-   MCP installer
-   Advanced context generation
-   Usage analytics

## Team (\$20/user/month)

-   Shared workspaces
-   Team policies
-   Centralized management
-   Audit logs

------------------------------------------------------------------------

# Directory Structure

    ~/.devpilot/
    config.json
    keys/
    providers/
    mcp/
    logs/
    cache/
    rules/
    prompts/
    plugins/

Project:

    .devpilot/
    project.json
    context.md
    architecture.md
    rules.md
    prompts/
    agents/

------------------------------------------------------------------------

# Revenue Opportunities

-   Pro subscriptions
-   Team subscriptions
-   Enterprise licensing
-   Marketplace commissions
-   Consulting

------------------------------------------------------------------------

# Long-Term Vision

Become the operating system for AI-assisted development by providing a
unified layer for installation, configuration, credentials, context,
integrations, and AI routing across all major coding assistants.
