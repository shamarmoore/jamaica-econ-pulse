set +e
B=https://dl.google.com/android/maven2/com/google/mlkit
V=1.0.0-beta4
curl -s -o c.aar $B/genai-common/$V/genai-common-$V.aar; mkdir c && cd c && unzip -q ../c.aar && unzip -q -o classes.jar -d cls; cd ..
find c/cls -name "*.class" | sed 's|c/cls/||;s|\.class$||;s|/|.|g' | grep -v '\$\|internal' | sort
for c in com.google.mlkit.genai.common.FeatureStatus com.google.mlkit.genai.common.DownloadCallback com.google.mlkit.genai.common.GenAiException; do echo "== $c"; javap -constants -cp c/cls $c; done
curl -s $B/genai-prompt/1.0.0-beta5/genai-prompt-1.0.0-beta5.pom | grep -A3 "<dependency>" | grep -o "<artifactId>[^<]*\|<version>[^<]*" | paste - - | grep -i "genai\|kotlin"
