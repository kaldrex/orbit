// Materializes group membership as a weak undirected CO_PRESENT_IN edge.
// Usage: params { groupJid: string, memberIds: [string] }
// memberIds must already be canonical Person IDs resolved upstream.
UNWIND $memberIds AS aId
UNWIND $memberIds AS bId
WITH aId, bId
WHERE aId < bId
MATCH (a:Person {id: aId}), (b:Person {id: bId})
MERGE (a)-[r:CO_PRESENT_IN]-(b)
  ON CREATE SET
    r.weight = 0.1,
    r.source = 'wa_group',
    r.group_jids = [$groupJid],
    r.first_seen = datetime()
  ON MATCH SET
    r.group_jids =
      CASE WHEN $groupJid IN r.group_jids
           THEN r.group_jids
           ELSE r.group_jids + $groupJid END,
    r.last_seen = datetime()
RETURN count(r) AS edges_touched
