// connector.js — Linear batch connector for Orbit.
//
// Polls Linear issues via GraphQL API, weights signals by issue state,
// and emits interaction signals for assigned issues.

import { BaseConnector } from "../base-connector.js";
import { issueWeight } from "./rules.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

const ISSUES_QUERY = `
  query RecentIssues($since: DateTime!) {
    issues(
      filter: { updatedAt: { gte: $since } }
      first: 100
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        state {
          name
        }
        assignee {
          name
          email
        }
        updatedAt
      }
    }
  }
`;

export default class LinearConnector extends BaseConnector {
  constructor(identityCache) {
    super("linear", "batch", identityCache);
  }

  /**
   * Check if Linear API token is configured.
   */
  isAvailable() {
    return !!process.env.LINEAR_API_TOKEN;
  }

  /**
   * Fetch issues updated since the given timestamp and return signals.
   * @param {Date} since
   * @returns {Promise<Array<Object>>}
   */
  async poll(since) {
    const token = process.env.LINEAR_API_TOKEN;
    if (!token) return [];

    let data;
    try {
      const res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: ISSUES_QUERY,
          variables: { since: since.toISOString() },
        }),
      });

      if (!res.ok) return [];
      data = await res.json();
    } catch {
      return [];
    }

    const issues = data?.data?.issues?.nodes || [];
    const signals = [];

    for (const issue of issues) {
      const assignee = issue.assignee;
      if (!assignee?.name) {
        this.stats.filtered++;
        continue;
      }

      const stateName = issue.state?.name || "";
      const weight = issueWeight(stateName);

      if (weight === 0.0) {
        this.stats.filtered++;
        continue;
      }

      // Register email→name mapping
      if (assignee.email && assignee.name) {
        this.identityCache.addEmail(assignee.email, assignee.name);
      }

      signals.push({
        contactName: assignee.name,
        channel: "linear",
        timestamp: issue.updatedAt || new Date().toISOString(),
        detail: `[${issue.identifier}] ${issue.title} (${stateName})`,
      });
    }

    return signals;
  }
}
