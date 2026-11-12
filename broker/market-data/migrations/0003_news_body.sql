-- The story under each headline (newswire spec 1.1.0). Optional on the wire, so nullable:
-- headlines stored before it, or sent without one, have none.

ALTER TABLE market_data.news ADD COLUMN body text;
