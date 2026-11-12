set +e
B=https://dl.google.com/android/maven2/com/google/mlkit
curl -s $B/genai-prompt/maven-metadata.xml | grep -o "<version>[^<]*" | tail -5
V=1.0.0-beta4
curl -s $B/genai-prompt/$V/genai-prompt-$V.pom | grep -A3 "<dependency>" | grep -o "<artifactId>[^<]*\|<version>[^<]*\|<groupId>[^<]*" | paste - - - 
curl -s -o p.aar $B/genai-prompt/$V/genai-prompt-$V.aar; mkdir p && cd p && unzip -q ../p.aar && unzip -q -o classes.jar -d cls; cd ..
find p/cls -name "*.class" | sed 's|p/cls/||;s|\.class$||;s|/|.|g' | grep -v '\$' | sort > list.txt; echo "CLASSES"; cat list.txt
for c in $(grep -E "prompt\.(Generation|GenerativeModel|GenerationConfig|ModelConfig|ModelReleaseStage|ModelPreference|GenerateContentRequest|GenerateContentResponse|TextPart|Candidate)$|java\.GenerativeModelFutures$" list.txt); do echo "== $c"; javap -cp p/cls $c | head -60; done
for c in $(grep -E "GenerateContentRequest\\\$Builder|GenerationConfig\\\$Builder|ModelConfig\\\$Builder" <(find p/cls -name "*.class" | sed 's|p/cls/||;s|\.class$||;s|/|.|g')); do echo "== $c"; javap -cp p/cls "$c" | head -40; done
