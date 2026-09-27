-- A run keeps metadata only. The rendered prompt held personal data from the
-- target record, and nothing read it back: the dispatch engine sends the
-- prompt from memory, and the receiver gets it in the dispatch POST. Dropping
-- the column also removes every prompt that earlier runs stored.
ALTER TABLE "agent_runs" DROP COLUMN "prompt";
