-- +goose Up
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 64);

-- Only normalized 256px PNGs are stored; profile queries never load the bytes.
CREATE TABLE user_avatars (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    data BYTEA NOT NULL CHECK (octet_length(data) <= 524288),
    version TEXT NOT NULL
);

-- +goose Down
DROP TABLE user_avatars;
ALTER TABLE users DROP COLUMN name;
