# Engineering Report & Technical Reference

> For comprehensive design decisions, test evidence, benchmark analysis, and architecture specifications, see **[`docs/ENGINEERING_NOTES.md`](file:///d:/network4%20project/docs/ENGINEERING_NOTES.md)**.

## Summary of Results

- **Automated Test Suite**: 179 passing tests across 30 test suites (`npm test`) with zero external API key requirements.
- **Live Local Connectors**: Real Ghost 5 Alpine and Lemmy 0.19.8 verified live against local Docker containers via `scripts/certify_live.js`.
- **Simulated Connectors**: Discourse, Dev.to, Hashnode, Slack, Webhooks, and MRSS feeds verified against the embedded mock platform suite.
- **Catalogue Verification**: 150 real public destinations verified reachable, with unknown/unregulated community rules honestly left `null`.
- **Storage Backend**: Local storage backend (`STORAGE_BACKEND=local`) enabled by default. MinIO was removed from Docker Compose because the image is no longer pullable, and S3 stays "Not verified".
