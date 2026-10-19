# Recording the Iris demo (60 to 75 seconds)

A short screen recording that shows the one thing that makes Iris different: it refuses to use facts it can't quote.

## Before you record

1. **Pick two or three target sites and test them first.** Good targets render their content on the server and don't block bots: run `iris <site>` and keep the ones that verify at least four facts. Avoid recording a site you haven't tried.
2. **Bust the cache.** The web app serves identical inputs from memory for six hours, which makes a run instant and gives it away. For the take, use a site (or recipient) you haven't run in the last few hours, or restart the server.
3. **Wake the deployment.** A free Render instance sleeps after 15 minutes. Open the URL a minute before recording.
4. **Set up the screen.** Browser window around 1280 × 800 at 110% zoom, bookmarks bar hidden, other tabs closed, light mode. Free recorders: OBS Studio, Loom's free plan, QuickTime (macOS) or the Xbox Game Bar (Windows).
5. **Never show `.env` or a terminal with your key in its history.**

## Shot list

| Time | On screen | Caption or voice-over |
| :--- | :--- | :--- |
| 0:00–0:06 | The landing page, headline in view | "AI cold emails love to invent facts. Iris only uses what it can quote." |
| 0:06–0:14 | Type the company site and a recipient ("Name, Role"), press **Research** | "Give it a company website." |
| 0:14–0:26 | The progress log: reading pages, extracting, "Verified 5 of 6 claims" | "It reads the site, proposes facts with exact quotes, then checks every quote against the page." |
| 0:26–0:40 | Scroll the verified facts as the highlighter sweeps; open "1 claim was dropped" | "Anything it can't find word for word is thrown out, and you can see what was dropped." |
| 0:40–0:56 | Drafts: switch between the three angles; hover a fact number so the fact lights up; press **Copy email** | "Three drafts, each built only on verified facts, with the receipts." |
| 0:56–1:08 | Optional: terminal running `iris <site> --out brief.md`, then an end card with the GitHub URL | "Open source, runs on free tiers. Link below." |

Keep the cursor slow and deliberate, and put the captions on screen: many people watch with the sound off.

## Sharing it

Upload the video to the post itself, and put the live URL and the repo at the end. A starting point:

> Most AI cold-email tools personalise by guessing. One invented funding round and the email is worse than generic.
>
> I built Iris to fix that: paste a company's website, and it drafts three first-touch emails using only facts it can quote word for word from that site. Every quote is checked in code, and anything it can't find is dropped, with the receipts shown.
>
> A NayaManas experiment. Open source, and it runs on free tiers.
>
> Try it: <your onrender.com URL>
> Code: https://github.com/YourAKShaw/iris

Add GitHub topics to the repo (`ai-agent`, `lead-generation`, `cold-email`, `llm`, `typescript`) and pin it on your profile.
