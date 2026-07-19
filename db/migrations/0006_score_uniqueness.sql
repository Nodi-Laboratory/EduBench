create unique index scores_response_profile_metric_unique
  on scores(model_response_id, score_profile_id, metric_key)
  where rubric_key is null and claim_index is null;
