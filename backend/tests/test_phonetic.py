# test_phonetics_ipa.py

import eng_to_ipa as ipa

# Test 3-letter words
words = ["cat", "dog", "run", "big", "sit", "yes", "now", "the"]

print("Testing eng_to_ipa with 3-letter words:\n")
for word in words:
    result = ipa.convert(word)
    print(f"{word:10} → {result}")

# Expected output:
# cat        → kæt
# dog        → dɔg
# run        → rʌn
# big        → bɪg
# sit        → sɪt
# yes        → jɛs
# now        → naʊ
# the        → ðə