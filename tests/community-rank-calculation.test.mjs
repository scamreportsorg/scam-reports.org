import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMUNITY_RANK_LADDER,
  communityActivityFromCounts,
  communityRankForPoints,
} from "../lib/community-ranks.ts";

test("rank progress is correct at every boundary", () => {
  for (const [index, definition] of COMMUNITY_RANK_LADDER.entries()) {
    const rank = communityRankForPoints(definition.minimumPoints);
    assert.equal(rank.level, definition.level);
    assert.equal(rank.name, definition.name);
    if (index > 0) {
      assert.equal(
        communityRankForPoints(definition.minimumPoints - 1).level,
        COMMUNITY_RANK_LADDER[index - 1].level,
      );
    }
  }
  assert.deepEqual(communityRankForPoints(20), {
    level: 2,
    name: "Contributor",
    minimumPoints: 10,
    nextName: "Regular",
    nextMinimumPoints: 30,
    pointsToNext: 10,
    progressPercent: 50,
  });
  assert.equal(communityRankForPoints(Number.NaN).name, "Newcomer");
  assert.equal(communityRankForPoints(-50).name, "Newcomer");
});

test("activity points count eligible approved work", () => {
  const activity = communityActivityFromCounts({
    approvedReports: 2,
    approvedReviews: 3,
    approvedComments: 20,
    scoreEligibleComments: 5,
  });
  assert.equal(activity.approvedContributionCount, 25);
  assert.equal(activity.contributionPoints, 33);
  assert.equal(activity.rank.name, "Regular");

  const clamped = communityActivityFromCounts({
    approvedReports: -1,
    approvedReviews: Number.NaN,
    approvedComments: 2,
    scoreEligibleComments: 99,
  });
  assert.equal(clamped.approvedCommentCount, 2);
  assert.equal(clamped.contributionPoints, 2);
});
