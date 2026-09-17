# World Watcher

RADAR — Universal Personal Intelligence Platform

Build a production-quality web application called Radar.

Core concept

Radar is a personal AI monitoring and intelligence platform.

The user tells Radar what they care about, what they want to find, or what they want monitored.

Radar then continuously monitors relevant public information sources, identifies meaningful changes and new opportunities, analyzes why they matter to the specific user, and notifies the user when something important happens.

The product is NOT primarily an AI chatbot.

The core value proposition is:

“Tell us what matters to you. We’ll watch the world for you.”

Examples of things users may want to monitor:

Cars and vehicles

Watches

Real estate

Flights and travel

Stocks

Forex

Cryptocurrency

Companies

Competitors

Products and prices

Collectibles

Jobs

News

Sports

Technology

Business opportunities

Anything else that can be monitored through publicly available information

The architecture must therefore be category-agnostic.

Do NOT hard-code Radar specifically for cars, stocks, watches, or any single category.



Product architecture

The application should have these major areas:

1. Dashboard

Show:

Welcome message

Number of active Radars

Important alerts

Recent discoveries

Daily intelligence summary

Activity over the last 7 days

Example:

“Good morning.”

“Your world changed 7 times today.”

Then categorize discoveries as:

Critical

Important

Interesting

No action needed



2. Create Radar

This is the core feature.

The user should be able to click:

+ Create Radar

and simply type a natural-language request.

Examples:

“I am looking for a BMW M340i from 2022 or newer, maximum 500,000 SEK, preferably black, in Sweden or Germany.”

“Monitor Tesla and tell me about major developments that could affect the stock.”

“Find Rolex Submariner watches below €12,000 that appear undervalued compared with the current market.”

“Monitor business class flights from Stockholm to Dubai and notify me when prices become unusually low.”

“I want to know when something important happens with NVIDIA.”

Radar should use AI to convert the natural-language request into a structured monitoring configuration automatically.

The user should NOT have to manually configure complex technical rules.



3. Radar configuration

After the AI understands the request, show the user a confirmation screen:

What Radar understood

Target

Location

Price range

Time period

Preferences

Important criteria

What events should be monitored

How frequently the user wants updates

Allow the user to edit these settings.

Include:

Notification frequency

Smart

Instant

Daily

Weekly

“Smart” should be the recommended default.



4. Monitoring engine

Each Radar should have a persistent monitoring state.

The system must remember:

Previous findings

Previous prices

Previous reports

Previous alerts

Previously seen URLs

Previously seen entities

User preferences

Changes over time

The system should not simply perform the same search repeatedly.

It should detect changes.

Examples:

New listing

Price decrease

Price increase

New article

New company announcement

New product

New competitor

New regulation

New investment development

New flight price

New opportunity

Previously seen information changing



5. AI relevance engine

Every discovered event should be evaluated for:

Relevance to the user

Importance

Confidence

Potential impact

Whether it is genuinely new

Whether it is duplicate information

Do not notify the user about insignificant information.

The system should prioritize signal over volume.

Each alert should include:

Why this matters

Explain why the discovery is relevant to THIS user’s Radar.

What changed

Clearly explain the new information.

Potential impact

Explain what the development could lead to.

Confidence

Show a confidence indicator.

Sources

Always show the underlying sources used for factual claims.

Never invent sources.



6. Personal memory

Radar should remember the user’s active monitoring interests.

For each user, store:

Active Radars

Previous discoveries

User preferences

Dismissed alerts

Saved discoveries

Notification preferences

The system should gradually learn which alerts the user finds useful.

However, do not silently change important monitoring criteria.

Always allow the user to see and edit what Radar is monitoring.



7. Alerts

Create an alerts inbox.

Each alert should have:

Title

Timestamp

Radar name

Importance

Summary

Why it matters

Sources

Save button

Dismiss button

Feedback button

Feedback:

Useful

Not useful

Too frequent

Not relevant



8. Daily intelligence

Create an automatically generated daily report.

Example:

Your Daily Radar

🚨 2 important developments

🟢 4 interesting discoveries

⚪ 3 minor changes

Each item should explain:

What happened

Why it matters

What changed since the previous report

Sources



9. Weekly intelligence

Create a weekly report showing:

Important developments

Trends

Major changes

Repeated signals

New opportunities

Things that became less relevant



10. Search and research architecture

Build the application so that AI research can use external search and data sources.

For the first version, design the architecture around:

AI web search

Search results

Source extraction

Source comparison

Structured data extraction

Deduplication

Change detection

Do not pretend that the application has access to every website.

Create a clean architecture where additional data providers and APIs can be added later.



11. Authentication

Add:

Email/password signup

Login

Password reset

User profile

Account settings

Logout



12. Subscription system

Prepare the application for Stripe subscriptions.

Create these initial plans:

Free

1 active Radar

Limited monitoring

Daily reports

Pro — 299 SEK/month

10 active Radars

More frequent monitoring

Smart alerts

Daily intelligence

Weekly intelligence

Pro+ — 599 SEK/month

50 active Radars

More frequent monitoring

Deep research

Advanced alerts

Do not hard-code these prices permanently. Make the subscription system configurable.

Create:

Pricing page

Checkout

Subscription status

Account billing page

Cancel subscription

Upgrade/downgrade

Use Stripe for actual payment processing.



13. Design

The product should feel like a premium technology product.

Design direction:

Minimal

Modern

Dark/light mode

Very clean

Premium

High information density without feeling cluttered

Excellent mobile responsive design

The product should feel closer to:

Bloomberg

Linear

Notion

Arc

Apple

than to a generic AI chatbot.

Do NOT make it look like a ChatGPT clone.

The central visual metaphor should be a radar/intelligence system.



14. Mobile-first

The application must work extremely well on:

iPhone

Android

Desktop

Tablet

The primary experience should be mobile-friendly because alerts are central to the product.



15. Security

Use secure authentication.

Never expose API keys in frontend code.

All AI API keys and payment secrets must be stored as secure server-side environment variables.

Users must only be able to access their own Radars, alerts, settings and data.



16. Architecture

Use a clean modular architecture.

Separate:

Frontend

Authentication

Database

AI layer

Monitoring jobs

Search layer

Alert system

Billing

User preferences

The architecture must allow us to replace or add AI models and data providers later.



17. Important MVP rule

Do NOT attempt to build every possible data integration immediately.

Build the complete product architecture and user experience first.

For the first functional version, use AI web search as the primary research mechanism.

The system should be designed so that specialized data providers can be added later.



18. Admin dashboard

Create an admin dashboard for the product owner.

Show:

Total users

Active users

Paid users

Active Radars

Alerts generated

Alerts opened

Alert feedback

Subscription status

System errors

API usage

Estimated AI cost



19. Analytics

Prepare the application for product analytics.

Track:

Signup

First Radar created

First alert received

First alert opened

Radar deleted

Radar edited

Alert saved

Alert dismissed

Subscription started

Subscription cancelled



20. Important implementation instruction

Do not create fake functionality and pretend it works.

If a feature requires an external API or secret key, create the proper integration structure and clearly identify what credentials or connection are required.

Build the application incrementally.

First create:

Authentication

Dashboard

Create Radar

Radar configuration

Database

Alerts

Basic AI research

Monitoring architecture

Billing architecture

Admin dashboard

Then we will iterate on the product through follow-up prompts.

Before making major architectural changes, explain what you are changing and why.

The end goal is a real SaaS product, not a visual prototype.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://radar-watch-world.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/b8ffeca5-6a91-4c18-8005-00cbc726c05b).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
