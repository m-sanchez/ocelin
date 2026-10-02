const config = require("./package.json").build;
const publisher = process.env.OCELIN_SIGNING_PUBLISHER?.trim();
if (process.env.OCELIN_REQUIRE_SIGNING === "1" && !publisher)
  throw new Error("A signed release requires OCELIN_SIGNING_PUBLISHER");
if (publisher && !publisher.startsWith("CN="))
  throw new Error(
    "OCELIN_SIGNING_PUBLISHER must be the full certificate subject starting with CN=",
  );
module.exports = {
  ...config,
  publish: [
    {
      provider: "github",
      owner: "m-sanchez",
      repo: "ocelin",
      releaseType: "draft",
    },
  ],
  forceCodeSigning: Boolean(publisher),
  win: {
    ...config.win,
    signExecutable: Boolean(publisher),
    ...(publisher
      ? { publisherName: publisher, verifyUpdateCodeSignature: true }
      : {}),
  },
};
